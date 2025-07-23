import { EOL } from 'node:os'

export const log = content => {
  const stringified = JSON.stringify(content)
  console.log(`${stringified}${EOL}`)
}
