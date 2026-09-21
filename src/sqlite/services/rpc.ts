import {
  apiControl,
  callNative,
  hasApiChannel,
  isNativeHost,
} from '../../services/nativeHost';

/** Compatibility facade for the ported table workspace. */
export type RpcChannel = 'projects' | 'apiControl';

export function hasChannel(channel: RpcChannel): boolean {
  return channel === 'apiControl' ? hasApiChannel() : isNativeHost();
}

export function callHost<T>(
  channel: RpcChannel,
  action: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 120_000
): Promise<T> {
  return channel === 'apiControl'
    ? apiControl<T>(action, payload)
    : callNative<T>(channel, action, payload, timeoutMs);
}
