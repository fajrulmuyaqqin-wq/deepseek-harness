import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-experimental-market',
  ['lib/types/index.js', 'lib/types/update-api-v1.js'],
)
