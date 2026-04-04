export class CodeRedemption {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const claimed = await this.state.storage.get('claimed');
    if (claimed) {
      return Response.json({ ok: false, error: 'already_claimed' });
    }

    await this.state.storage.put('claimed', true);
    await this.state.storage.setAlarm(Date.now() + 600_000);
    return Response.json({ ok: true });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}
