interface FlowDesktopApi {
  platform: NodeJS.Platform;
  ping(): Promise<string>;
  openExternal(url: string): Promise<void>;
}

declare interface Window {
  flowApp: FlowDesktopApi;
}
