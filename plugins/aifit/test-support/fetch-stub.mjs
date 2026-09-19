import { writeFile } from 'node:fs/promises';

globalThis.fetch = async (url, options = {}) => {
  const outputPath = process.env.AIFIT_TEST_FETCH_OUTPUT;
  if (!outputPath) throw new Error('AIFit test fetch stub has no output path');
  await writeFile(outputPath, JSON.stringify({
    url: String(url),
    method: options.method,
    headers: options.headers,
    body: options.body ? JSON.parse(options.body) : null,
  }));
  return new Response(JSON.stringify({ status: 'saved', request_id: 'stub-request' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
