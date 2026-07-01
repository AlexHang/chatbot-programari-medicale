class StubChannelProvider {
  constructor(channel) {
    this.channel = channel
  }

  async send(message) {
    return {
      channel: this.channel,
      status: 'queued',
      message,
    }
  }

  async normalize(payload) {
    return {
      channel: this.channel,
      patientCode: payload.patientCode || null,
      from: payload.from || payload.email || payload.phone || 'necunoscut',
      text: payload.text || payload.message || '',
      metadata: payload,
    }
  }
}

class ChannelConnector {
  constructor(providers) {
    this.providers = new Map(
      Object.entries(
        providers || {
          web: new StubChannelProvider('web'),
          email: new StubChannelProvider('email'),
          whatsapp: new StubChannelProvider('whatsapp'),
          facebook: new StubChannelProvider('facebook'),
        },
      ),
    )
  }

  listChannels() {
    return [...this.providers.keys()]
  }

  async receive(channel, payload) {
    const provider = this.providers.get(channel)

    if (!provider) {
      throw new Error(`Unsupported channel: ${channel}`)
    }

    return provider.normalize(payload)
  }

  async send(channel, message) {
    const provider = this.providers.get(channel)

    if (!provider) {
      throw new Error(`Unsupported channel: ${channel}`)
    }

    return provider.send(message)
  }
}

module.exports = {
  ChannelConnector,
  StubChannelProvider,
}
