function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) {
      deepFreeze(obj[key]);
    }
  }
  return obj;
}

export const MONITOR_PROVIDERS_CATALOG = deepFreeze([
  {
    type: 'stock',
    text: '📈 股票',
    callbackData: 'monitor_add:type:stock',
    aliases: ['stock', '股票'],
    nextStep: 'await_code',
    sessionData: { providerType: 'stock' },
    prompt: '请输入股票代码：\n(发送 /cancel 退出)'
  }
]);

export function buildMonitorCategoryKeyboard(catalog = MONITOR_PROVIDERS_CATALOG) {
  return {
    inline_keyboard: catalog.map(p => [
      { text: p.text, callback_data: p.callbackData }
    ])
  };
}

export function getProviderByType(type, catalog = MONITOR_PROVIDERS_CATALOG) {
  return catalog.find(p => p.type === type);
}

export function getProviderByCallbackData(callbackData, catalog = MONITOR_PROVIDERS_CATALOG) {
  return catalog.find(p => p.callbackData === callbackData);
}

export function getProviderByTextInput(text, catalog = MONITOR_PROVIDERS_CATALOG) {
  const trimmed = (text || '').trim().toLowerCase();
  return catalog.find(p => p.aliases.some(a => a.toLowerCase() === trimmed));
}

export function getProviderSelectionTransition(provider) {
  if (!provider) return null;
  return {
    nextStep: provider.nextStep,
    sessionData: provider.sessionData,
    prompt: provider.prompt
  };
}
