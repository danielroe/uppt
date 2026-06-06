export function makePkgFormatter (source: string): (pkg: unknown) => string {
  const indentMatch = source.match(/\n([\t ]+)"/)
  const indent: string | number = indentMatch ? indentMatch[1]! : 2
  const usesCRLF = /\r\n/.test(source)
  const trailingNewline = source.endsWith('\r\n') ? '\r\n' : source.endsWith('\n') ? '\n' : ''
  return (pkg) => {
    let out = JSON.stringify(pkg, null, indent)
    if (usesCRLF) out = out.replace(/\n/g, '\r\n')
    return out + trailingNewline
  }
}
