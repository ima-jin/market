import type { AppVaultCredentials, LoadFromVaultOptions, VaultBootOptions } from '@ima-jin/auth-client';

/** Unit-test seam; production smoke tests exercise the real published SDK. */
export function mockVaultBoot(load: (options: LoadFromVaultOptions) => Promise<AppVaultCredentials>) {
  return <Config extends object>(options: VaultBootOptions<Config>) => {
    let config: Readonly<Config> | undefined;
    return {
      getConfig() {
        if (!config) throw new Error('FAKE_TEST_ONLY_CONFIG_UNAVAILABLE');
        return config;
      },
      async start(callback: (value: Readonly<Config>) => unknown) {
        try {
          config = Object.freeze(await options.configure(await load(options.vault)));
          return await callback(config);
        } catch {
          config = undefined;
          throw new Error('FAKE_TEST_ONLY_STARTUP_FAILED');
        }
      },
    };
  };
}
