const stub = new URL('./schemastery-stub.ts', import.meta.url).href
export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/schemastery') {
    return { url: stub, shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/dsh-session') {
    return { url: new URL('./dsh-session-stub.ts', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
