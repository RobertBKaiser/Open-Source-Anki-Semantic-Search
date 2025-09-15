import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

// User rule: Keep lint quiet like before; apply React-specific rules only to renderer files.

const reactRecommended = eslintPluginReact.configs.flat.recommended
const reactJsxRuntime = eslintPluginReact.configs.flat['jsx-runtime']

export default tseslint.config(
  { ignores: ['**/node_modules', '**/dist', '**/out', '**/build', '**/out/**', '**/build/**', '**/tests/**', '**/database/**'] },

  // Base TS rules
  tseslint.configs.recommended,

  // Relax strict rules to match previous behavior
  {
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
      'prefer-const': 'off',
      'react/display-name': 'off',
      'prettier/prettier': 'off'
    }
  },

  // Renderer: React + hooks + react-refresh
  {
    files: ['src/renderer/src/**/*.{ts,tsx,js,jsx}'],
    ...reactRecommended
  },
  {
    files: ['src/renderer/src/**/*.{ts,tsx,js,jsx}'],
    ...reactJsxRuntime,
    settings: { react: { version: 'detect' } },
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // Quiet hook rules to match previous behavior
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react/display-name': 'off',
      'react-refresh/only-export-components': 'off',
      'react/react-in-jsx-scope': 'off'
    }
  },

  // Node/Preload: disable React-only rules
  {
    files: ['src/main/**/*.{ts,tsx,js}', 'src/preload/**/*.{ts,tsx,js}'],
    rules: {
      'react-refresh/only-export-components': 'off',
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off'
    }
  },

  // No Prettier integration here to avoid formatting warnings
)
