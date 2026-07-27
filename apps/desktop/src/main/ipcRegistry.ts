import { ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  desktopIpcChannels,
  type DesktopApi,
  type DesktopIpcChannel,
} from "../shared/desktopApi";

type DesktopIpcMethod = keyof typeof desktopIpcChannels;

type DesktopIpcHandler<Method extends DesktopIpcMethod> = (
  input: Parameters<DesktopApi[Method]> extends []
    ? undefined
    : Parameters<DesktopApi[Method]>[0],
  event: IpcMainInvokeEvent,
) => ReturnType<DesktopApi[Method]> | Awaited<ReturnType<DesktopApi[Method]>>;

export type DesktopIpcHandlers = {
  [Method in DesktopIpcMethod]: DesktopIpcHandler<Method>;
};

export type DesktopIpcRegistryOptions = {
  trustedSender(event: IpcMainInvokeEvent): boolean;
  onError(input: {
    channel: DesktopIpcChannel;
    request: unknown;
    cause: unknown;
  }): void;
};

export function registerDesktopIpcHandlers(
  handlers: DesktopIpcHandlers,
  options: DesktopIpcRegistryOptions,
): void {
  for (const method of Object.keys(desktopIpcChannels) as DesktopIpcMethod[]) {
    const channel = desktopIpcChannels[method];
    const handler = handlers[method] as (
      input: unknown,
      event: IpcMainInvokeEvent,
    ) => unknown;
    ipcMain.handle(channel, async (event, input: unknown) => {
      try {
        if (!options.trustedSender(event)) {
          throw new Error("Blocked IPC from an untrusted renderer.");
        }
        return await handler(input, event);
      } catch (cause) {
        options.onError({ channel, request: input, cause });
        throw cause;
      }
    });
  }
}
