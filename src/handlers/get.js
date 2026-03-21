import { assembleContext } from '../utils/yaml.js';

export async function handleGet(env) {
  const [core, active, changelog, reviewQueue] = await Promise.all([
    env.PCP.get('core'),
    env.PCP.get('active'),
    env.PCP.get('changelog'),
    env.PCP.get('review_queue'),
  ]);

  const yaml = assembleContext(core, active, changelog, reviewQueue);

  return {
    content: [{ type: 'text', text: yaml }],
  };
}
