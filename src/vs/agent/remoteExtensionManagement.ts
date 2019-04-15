/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ParsedArgs, IEnvironmentService } from 'vs/platform/environment/common/environment';
import { PersistentProtocol, ProtocolConstants, ISocket } from 'vs/base/parts/ipc/common/ipc.net';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { ILogService, LogLevel, getLogLevel } from 'vs/platform/log/common/log';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { ConfigurationService } from 'vs/platform/configuration/node/configurationService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IRequestService } from 'vs/platform/request/node/request';
import { RequestService } from 'vs/platform/request/node/requestService';
import { NullTelemetryService, ITelemetryAppender, NullAppender, combinedAppender, LogAppender } from 'vs/platform/telemetry/common/telemetryUtils';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IExtensionGalleryService, IExtensionManagementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionGalleryService } from 'vs/platform/extensionManagement/node/extensionGalleryService';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { DialogChannelClient } from 'vs/platform/dialogs/node/dialogIpc';
import { ExtensionManagementService } from 'vs/platform/extensionManagement/node/extensionManagementService';
import { InstantiationService } from 'vs/platform/instantiation/common/instantiationService';
import { ExtensionManagementChannel } from 'vs/platform/extensionManagement/node/extensionManagementIpc';
import { RemoteAgentEnvironmentChannel } from 'vs/agent/remoteAgentEnvironmentImpl';
import { Emitter, Event } from 'vs/base/common/event';
import { IPCServer, ClientConnectionEvent, StaticRouter, IMessagePassingProtocol } from 'vs/base/parts/ipc/common/ipc';
import { IDownloadService } from 'vs/platform/download/common/download';
import { DownloadServiceChannelClient } from 'vs/platform/download/node/downloadIpc';
import { IURITransformer } from 'vs/base/common/uriIpc';
import { FollowerLogService, LogLevelSetterChannelClient } from 'vs/platform/log/node/logIpc';
import { createSpdLogService } from 'vs/platform/log/node/spdlogService';
import { RemoteExtensionLogFileName } from 'vs/workbench/services/remote/common/remoteAgentService';
import { EnvironmentService } from 'vs/platform/environment/node/environmentService';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { REMOTE_FILE_SYSTEM_CHANNEL_NAME } from 'vs/platform/remote/common/remoteAgentFileSystemChannel';
import { RemoteAgentFileSystemChannel } from 'vs/agent/remoteAgentFileSystemImpl';
import { RemoteAgentConnectionContext } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { createRemoteURITransformer } from 'vs/agent/remoteUriTransformer';
import { Main as CliMain } from 'vs/code/node/cliProcessMain';
import { ILocalizationsService } from 'vs/platform/localizations/common/localizations';
import { LocalizationsService } from 'vs/platform/localizations/node/localizations';
import { VSBuffer } from 'vs/base/common/buffer';
import product from 'vs/platform/product/node/product';
import { AppInsightsAppender } from 'vs/platform/telemetry/node/appInsightsAppender';
import { ITelemetryServiceConfig, TelemetryService } from 'vs/platform/telemetry/common/telemetryService';
import { resolveCommonProperties } from 'vs/platform/telemetry/node/commonProperties';
import pkg from 'vs/platform/product/node/package';
import ErrorTelemetry from 'vs/platform/telemetry/node/errorTelemetry';

export interface IExtensionsManagementProcessInitData {
	args: ParsedArgs;
}

class SocketServer<TContext = string> extends IPCServer<TContext> {

	private _onDidConnectEmitter: Emitter<ClientConnectionEvent>;

	constructor() {
		const emitter = new Emitter<ClientConnectionEvent>();
		super(emitter.event);
		this._onDidConnectEmitter = emitter;
	}

	public acceptConnection(protocol: IMessagePassingProtocol, onDidClientDisconnect: Event<void>): void {
		this._onDidConnectEmitter.fire({ protocol, onDidClientDisconnect });
	}
}

export class ManagementConnection {

	private _onClose = new Emitter<void>();
	readonly onClose: Event<void> = this._onClose.event;

	private readonly _protocol: PersistentProtocol;
	private _disposed: boolean;
	private _disconnectWaitTimer: NodeJS.Timeout | null = null;

	constructor(managementServer: RemoteExtensionManagementServer, protocol: PersistentProtocol) {
		this._protocol = protocol;
		this._disposed = false;
		this._disconnectWaitTimer = null;

		this._protocol.onClose(() => this._cleanResources());
		this._protocol.onSocketClose(() => {
			// The socket has closed, let's give the renderer a certain amount of time to reconnect
			this._disconnectWaitTimer = setTimeout(() => {
				this._disconnectWaitTimer = null;
				this._cleanResources();
			}, ProtocolConstants.ReconnectionGraceTime);
		});
		managementServer.socketServer.acceptConnection(this._protocol, this.onClose);
	}

	private _cleanResources(): void {
		if (this._disposed) {
			// already called
			return;
		}
		this._disposed = true;
		const socket = this._protocol.getSocket();
		this._protocol.dispose();
		socket.end();
		this._onClose.fire(undefined);
	}

	public acceptReconnection(socket: ISocket, initialDataChunk: VSBuffer): void {
		if (this._disconnectWaitTimer) {
			clearTimeout(this._disconnectWaitTimer);
			this._disconnectWaitTimer = null;
		}
		this._protocol.beginAcceptReconnection(socket, initialDataChunk);
		this._protocol.endAcceptReconnection();
	}
}

const eventPrefix = 'remoteAgent';

export class RemoteExtensionManagementServer {

	public readonly socketServer: SocketServer<RemoteAgentConnectionContext>;
	private readonly _uriTransformerCache: { [remoteAuthority: string]: IURITransformer; };

	constructor(
		private readonly _environmentService: IEnvironmentService
	) {
		this.socketServer = new SocketServer<RemoteAgentConnectionContext>();
		this._uriTransformerCache = Object.create(null);
		this._createServices(this.socketServer);
	}

	private _createServices(server: SocketServer<RemoteAgentConnectionContext>): void {
		const services = new ServiceCollection();

		// TODO: @Sandy @Joao need dynamic context based router
		const router = new StaticRouter<RemoteAgentConnectionContext>(ctx => ctx.clientId === 'renderer');
		const logLevelClient = new LogLevelSetterChannelClient(server.getChannel('loglevel', router));
		const logService = new FollowerLogService(logLevelClient, createSpdLogService(RemoteExtensionLogFileName, LogLevel.Info, this._environmentService.logsPath));

		services.set(IEnvironmentService, this._environmentService);
		services.set(ILogService, logService);
		services.set(IConfigurationService, new SyncDescriptor(ConfigurationService, [this._environmentService.machineSettingsPath]));
		services.set(IRequestService, new SyncDescriptor(RequestService));

		let appInsightsAppender: ITelemetryAppender | null = NullAppender;
		if (!this._environmentService.args['disable-telemetry'] && product.enableTelemetry && this._environmentService.isBuilt) {
			if (product.aiConfig && product.aiConfig.asimovKey) {
				appInsightsAppender = new AppInsightsAppender(eventPrefix, null, product.aiConfig.asimovKey, logService);
				// disposables.push(appInsightsAppender); // TODO Ensure the AI appender is disposed so that it flushes remaining data
			}

			const config: ITelemetryServiceConfig = {
				appender: combinedAppender(appInsightsAppender, new LogAppender(logService)),
				commonProperties: resolveCommonProperties(product.commit, pkg.version + '-remote', undefined, this._environmentService.installSourcePath),
				piiPaths: [this._environmentService.appRoot]
			};

			services.set(ITelemetryService, new SyncDescriptor(TelemetryService, [config]));
		} else {
			services.set(ITelemetryService, NullTelemetryService);
		}

		services.set(IExtensionGalleryService, new SyncDescriptor(ExtensionGalleryService));

		const dialogChannel = server.getChannel('dialog', router);
		services.set(IDialogService, new DialogChannelClient(dialogChannel));

		const downloadChannel = server.getChannel('download', router);
		services.set(IDownloadService, new DownloadServiceChannelClient(downloadChannel, () => this.getUriTransformer('renderer') /* TODO: @Sandy @Joao need dynamic context based router */));

		services.set(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService, [true]));

		const instantiationService = new InstantiationService(services);
		services.set(ILocalizationsService, instantiationService.createInstance(LocalizationsService));

		instantiationService.invokeFunction(accessor => {
			const remoteExtensionEnvironmentChannel = new RemoteAgentEnvironmentChannel(this._environmentService, logService);
			server.registerChannel('remoteextensionsenvironment', remoteExtensionEnvironmentChannel);

			const remoteFileSystemChannel = new RemoteAgentFileSystemChannel(logService);
			server.registerChannel(REMOTE_FILE_SYSTEM_CHANNEL_NAME, remoteFileSystemChannel);

			const extensionManagementService = accessor.get(IExtensionManagementService);
			const channel = new ExtensionManagementChannel(extensionManagementService, (ctx: RemoteAgentConnectionContext) => this.getUriTransformer(ctx.remoteAuthority));
			server.registerChannel('extensions', channel);

			// clean up deprecated extensions
			(extensionManagementService as ExtensionManagementService).removeDeprecatedExtensions();

			// tslint:disable-next-line: no-unused-expression
			new ErrorTelemetry(accessor.get(ITelemetryService)); // TODO dispose
		});
	}

	private getUriTransformer(remoteAuthority: string): IURITransformer {
		if (!this._uriTransformerCache[remoteAuthority]) {
			this._uriTransformerCache[remoteAuthority] = createRemoteURITransformer(remoteAuthority);
		}
		return this._uriTransformerCache[remoteAuthority];
	}
}

export class RemoteExtensionManagementCli {

	private readonly cliMain: CliMain;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		this.cliMain = instantiationService.createInstance(CliMain, true);
	}

	static shouldSpawnCli(argv: ParsedArgs): boolean {
		return !!argv['list-extensions']
			|| !!argv['install-extension']
			|| !!argv['uninstall-extension']
			|| !!argv['locate-extension'];
	}

	static instantiate(environmentService: EnvironmentService): RemoteExtensionManagementCli {
		const services = new ServiceCollection();

		services.set(IEnvironmentService, environmentService);
		const logService = createSpdLogService('cli', getLogLevel(environmentService), environmentService.logsPath);
		services.set(ILogService, logService);
		const instantiationService: IInstantiationService = new InstantiationService(services);

		services.set(IConfigurationService, new SyncDescriptor(ConfigurationService, [environmentService.machineSettingsPath]));
		services.set(IRequestService, new SyncDescriptor(RequestService));
		services.set(ITelemetryService, NullTelemetryService);
		services.set(IExtensionGalleryService, new SyncDescriptor(ExtensionGalleryService));

		services.set(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService, [true]));

		return instantiationService.createInstance(RemoteExtensionManagementCli);
	}

	async run(argv: ParsedArgs): Promise<boolean> {
		if (RemoteExtensionManagementCli.shouldSpawnCli(argv)) {
			await this.cliMain.run(argv);
			return true;
		}

		return Promise.resolve(false);
	}

}