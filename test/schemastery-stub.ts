// Minimal schemastery stand-in used only by the local test run. The real
// plugin resolves @deepseek-ai/schemastery from the DSH host at runtime.
const decorate = (fields) => {
  const fn = () => decorate({ ...fields, called: true })
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === 'required') return () => decorate({ ...fields, required: true })
      if (prop === 'volatile') return () => decorate({ ...fields, volatile: true })
      if (prop === 'default') return (value) => decorate({ ...fields, default: value })
      if (prop === 'object') return (shape) => decorate({ kind: 'object', shape })
      if (prop === 'array') return (inner) => decorate({ kind: 'array', inner })
      if (prop === 'string' || prop === 'number' || prop === 'boolean') return decorate({ kind: String(prop) })
      return target[prop]
    },
    apply() {
      return decorate({ ...fields, called: true })
    },
  })
}
const z = decorate({})
export default z
