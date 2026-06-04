interface Env {}

export const onRequestPost: PagesFunction<Env> = async () => {
  return new Response(JSON.stringify({ ok: true, message: 'Stub server assets reset success' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
