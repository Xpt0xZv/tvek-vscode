## Summary

<!-- Briefly describe what this PR changes and why. -->

## Related Issue

<!-- Link any related issue, e.g. Closes #123, or write N/A. -->

## Checklist

- [ ] `npm run check` (`tsc --noEmit` and `eslint`) passes with zero errors or warnings
- [ ] `npm run build` produces a clean `dist/extension.js` bundle
- [ ] `npm test` (unit and E2E suites) passes
- [ ] Runtime `"dependencies"` in `package.json` retains `vscode-languageclient` as the sole production dependency
- [ ] `.vscodeignore` strict allowlist verified via `npx vsce ls` (no source, test, `.github/`, or `node_modules/` leakage)
- [ ] Regression unit and/or E2E tests added or updated for behavior changes
