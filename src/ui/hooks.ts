let iconRefreshHook: (() => void) | null = null;

export function registerIconRefreshHook(hook: () => void): void {
  iconRefreshHook = hook;
}

export function triggerIconRefresh(): void {
  iconRefreshHook?.();
}

export type BasicHooks = {
  onRenderInputs: () => void;
  onSetRunning: (active: boolean) => void;
  onSetStatus: (text: string, errorDetail?: string) => void;
};
let basicHooks: BasicHooks | null = null;

export function registerBasicHooks(hooks: BasicHooks): void {
  basicHooks = hooks;
}

export function getBasicHooks(): BasicHooks | null {
  return basicHooks;
}
