// Jest environment adapter. Use in jest config:
//
//   // jest.config.js
//   module.exports = { testEnvironment: '@miaskiewicz/turbo-dom/jest' }
//
// or point directly at this file:
//
//   testEnvironment: './node_modules/@miaskiewicz/turbo-dom/src/environment/jest.cjs'
//
// Per-file / project options:
//   testEnvironmentOptions: { html: '<!doctype html>...', url: 'http://localhost/' }
//
// Requires `jest-environment-node` (a jest dependency) to be resolvable.

const nodeEnv = require('jest-environment-node');
const NodeEnvironment = nodeEnv.TestEnvironment || nodeEnv.default || nodeEnv;

class TurboDomEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    const projectConfig = config.projectConfig || config;
    this.__opts = projectConfig.testEnvironmentOptions || {};
  }

  async setup() {
    await super.setup();
    // runtime is ESM; load it dynamically from this CJS environment
    const { installGlobals } = await import('./install.mjs');
    this.__installation = installGlobals(this.global, this.__opts.turboDom || this.__opts);
  }

  async teardown() {
    const installation = this.__installation;
    this.__installation = null;
    try {
      this.fakeTimersModern?.useRealTimers();
      this.fakeTimers?.useRealTimers();
    } finally {
      try {
        if (installation) {
          try { installation.env.reset(); }
          finally { installation.teardown(); }
        }
      } finally {
        await super.teardown();
      }
    }
  }
}

module.exports = TurboDomEnvironment;
module.exports.default = TurboDomEnvironment;
module.exports.TestEnvironment = TurboDomEnvironment;
