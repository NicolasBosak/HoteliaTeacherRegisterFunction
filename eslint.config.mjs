import js from '@eslint/js';

const nodeGlobals = {
    require: 'readonly',
    module: 'writable',
    exports: 'writable',
    process: 'readonly',
    console: 'readonly',
    Buffer: 'readonly',
    URL: 'readonly',
    fetch: 'readonly',
    AbortSignal: 'readonly',
    setTimeout: 'readonly',
    __dirname: 'readonly'
};

const jestGlobals = {
    jest: 'readonly',
    describe: 'readonly',
    it: 'readonly',
    expect: 'readonly',
    beforeEach: 'readonly',
    afterEach: 'readonly',
    beforeAll: 'readonly',
    afterAll: 'readonly',
    global: 'writable'
};

export default [
    {
        ignores: ['node_modules/', 'coverage/', 'infra/']
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: nodeGlobals
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
            eqeqeq: ['error', 'smart'],
            'no-var': 'error',
            'prefer-const': 'error'
        }
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            globals: { ...nodeGlobals, ...jestGlobals }
        }
    }
];
