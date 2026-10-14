// Test-process-only preload. Production has no env or file-backed secret fallback.
const Module = process.getBuiltinModule('node:module');
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  const sdk = originalLoad.call(this, name, ...args);
  if (name === '@ima-jin/auth-client') {
    return {
      ...sdk,
      async loadFromVault(options) {
        if (options.keys.length !== 1 || options.keys[0].key !== 'SESSION_SECRET'
          || options.keys[0].onMissing !== 'fail') {
          throw new Error('Unexpected test vault declaration');
        }
        const mode = process.env.FAKE_VAULT_TEST_MODE;
        if (mode === 'unreachable') throw new Error('FAKE_TEST_ONLY_PROVIDER_ERROR_MUST_NOT_LEAK');
        if (mode === 'missing') return { values: {}, degraded: [] };
        const value = mode === 'rotated'
          ? 'FAKE_TEST_ONLY_ROTATED_SESSION_MATERIAL'
          : 'FAKE_TEST_ONLY_VAULT_SESSION_MATERIAL';
        return { values: { SESSION_SECRET: value }, degraded: [] };
      },
    };
  }
  return sdk;
};
