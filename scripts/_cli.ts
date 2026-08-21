import process from 'node:process'

/**
 * Run `main` only when the module is the process entrypoint, so tests can
 * import a script for its exports without triggering a release.
 *
 * @param url the calling module's `import.meta.url`
 * @param main entrypoint; sync throws and rejections both exit non-zero
 */
export function runMain (url: string, main: () => unknown): void {
  if (url !== `file://${process.argv[1]}`) return
  const fail = (err: unknown) => {
    console.error(err)
    process.exit(1)
  }
  try {
    const result = main()
    if (result instanceof Promise) result.catch(fail)
  }
  catch (err) {
    fail(err)
  }
}
