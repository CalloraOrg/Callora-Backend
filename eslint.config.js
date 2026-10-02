import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

/**
 * Custom rule to detect async route handlers that are not wrapped with asyncHandler or try/catch.
 * This prevents unhandled promise rejections in Express 4.
 */
const noUnwrappedAsyncHandlers = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Async route handlers must be wrapped with asyncHandler or use try/catch to prevent unhandled rejections",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        // Match app.get/post/put/patch/delete() patterns
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.name &&
          ["get", "post", "put", "patch", "delete"].includes(
            node.callee.property.name,
          )
        ) {
          // Find the handler argument (typically the last parameter, or 3rd if middleware is present)
          const handlers = node.arguments.slice(1); // Skip the path argument

          for (const handler of handlers) {
            // Check if handler is an async function
            if (
              handler.type === "ArrowFunctionExpression" ||
              handler.type === "FunctionExpression"
            ) {
              const isAsync = handler.async === true;
              if (!isAsync) continue; // Skip non-async handlers

              // Check if it's wrapped with asyncHandler
              const parent = handler.parent;
              if (
                parent.type === "CallExpression" &&
                parent.callee.name === "asyncHandler"
              ) {
                continue; // OK: wrapped with asyncHandler
              }

              // Check if handler contains try-catch
              if (handler.body.type === "BlockStatement") {
                const hasTryCatch = handler.body.body.some(
                  (stmt) => stmt.type === "TryStatement",
                );
                if (hasTryCatch) {
                  continue; // OK: has try-catch
                }

                // Unhandled async handler found
                context.report({
                  node: handler,
                  message:
                    "Async route handler must be wrapped with asyncHandler() or contain a try-catch block to prevent unhandled promise rejections",
                });
              }
            }
          }
        }
      },
    };
  },
};

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "custom": { rules: { "no-unwrapped-async-handlers": noUnwrappedAsyncHandlers } },
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "error",
      "custom/no-unwrapped-async-handlers": "error",
    },
  },
  {
    files: ["src/scripts/**/*.ts", "src/logger.ts", "src/**/*.test.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**"],
  },
];
