import { EOL } from 'node:os'

export const log = content => {
  const serialized = Object.fromEntries(
    Object.entries(content).map(([key, value]) => {
      try {
        if ((value instanceof Error) || ((key === 'error') && (value?.code || value?.message || value?.stack))) {
          const { code = 'Error', message = null, stack = null } = value
          value = { code, message, stack }
        }
        const result = JSON.parse(JSON.stringify(value))
        return [key, result]
      } catch (error) {
        return [key, null]
      }
    })
  )
  const stringified = JSON.stringify(serialized)
  console.log(`${stringified}${EOL}`)
}
