interface Env {}

export const onRequestPost: PagesFunction<Env> = async ({ request }) => {
  try {
    const body: { image?: string } = await request.json();
    const imageData = body.image;
    if (!imageData) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing image data' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const matches = imageData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid base64 image data format' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // On Cloudflare Pages Functions, we cannot write to disk.
    // Instead, we bypass and return the base64 URL directly, which the client
    // will keep in IndexedDB and submit back to the /api/ai/generate API.
    return new Response(JSON.stringify({ ok: true, url: imageData }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ ok: false, error: error?.message || 'Server error uploading image' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
