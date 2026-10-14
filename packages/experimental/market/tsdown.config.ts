import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  import.meta.dirname,
  ['lib/types/index.js', 'lib/types/update-api-v1.js'],
)
