import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REQUIRED_ENDPOINTS = ['list', 'restore', 'delete', 'deleteWorkspace']
const ARTIFACTS = ['lib/typert.host.js', 'lib/typert.remote-client.js']

function verifyArtifact(relativePath) {
  const path = resolve(relativePath)
  if (!existsSync(path)) {
    throw new Error(`missing generated Typert artifact: ${relativePath}`)
  }

  const source = readFileSync(path, 'utf8')
  for (const method of REQUIRED_ENDPOINTS) {
    const endpoint = `archivedSessions/${method}`
    const endpointOffset = source.indexOf(endpoint)
    if (endpointOffset < 0) {
      throw new Error(`${relativePath} is missing endpoint ${endpoint}`)
    }

    // The generated contribution places the endpoint id before its invocation
    // codecs. Require strict mode in that same descriptor, not merely the
    // endpoint name somewhere in an unrelated source/model string.
    const descriptor = source.slice(endpointOffset, endpointOffset + 1600)
    if (!descriptor.includes("mode: 'strict'")) {
      throw new Error(`${relativePath} has no strict codec for ${endpoint}`)
    }
  }
}

try {
  for (const artifact of ARTIFACTS) verifyArtifact(artifact)
  console.log(`Typert contract verified: ${ARTIFACTS.join(', ')}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
