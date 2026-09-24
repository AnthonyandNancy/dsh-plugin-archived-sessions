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

    // 0.1.7 replaced the `schema:` codec contribution with a `create:` factory
    // (`TypertRemoteContribution.create`). A `schema:` artifact is accepted by the
    // generator but rejected at run time by dsh-typert-loader, which then withdraws
    // every strict definition in the same fiber -- including the built-in
    // directoryPicker/agentPresets/pluginInventory remotes. Both directions are
    // checked so that a stale artifact can never be published again.
    if (!descriptor.includes('create:')) {
      throw new Error(`${relativePath} has no create() codec factory for ${endpoint} (0.1.7 requires create:, not schema:)`)
    }
    if (/(^|[\s{,])schema:\s/.test(descriptor)) {
      throw new Error(`${relativePath} still uses the removed schema: codec contribution for ${endpoint}`)
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
