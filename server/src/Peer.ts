import mediasoup from 'mediasoup';

export class Peer {
  transports = new Map<string, mediasoup.types.WebRtcTransport>();
  consumers = new Map<string, mediasoup.types.Consumer>();
  producers = new Map<string, mediasoup.types.Producer>();

  constructor(public readonly id: string, public readonly name: string) {}

  addTransport(transport: mediasoup.types.WebRtcTransport) {
    this.transports.set(transport.id, transport);
  }

  async connectTransport(
    transportId: string,
    dtlsParameters: mediasoup.types.DtlsParameters,
  ) {
    if (!this.transports.has(transportId)) {
      return;
    }

    await this.transports.get(transportId)?.connect({
      dtlsParameters,
    });
  }

  async createProducer(
    producerTransportId: string,
    rtpParameters: mediasoup.types.RtpParameters,
    kind: mediasoup.types.MediaKind,
  ) {
    const producer = await this.transports.get(producerTransportId)?.produce({
      kind,
      rtpParameters,
    });

    if (!producer) {
      throw new Error(`No producer found for ${producerTransportId}`);
    }

    this.producers.set(producer.id, producer);

    producer.on('transportclose', () => {
      console.log(`Producer transport close`, {
        name: this.name,
        producerId: producer.id,
      });

      producer.close();
      this.producers.delete(producer.id);
    });

    return producer;
  }

  async createConsumer(
    consumerTransportId: string,
    producerId: string,
    rtpCapabilities: mediasoup.types.RtpCapabilities,
  ) {
    const consumerTransport = this.transports.get(consumerTransportId);

    let consumer: mediasoup.types.Consumer | undefined;

    try {
      consumer = await consumerTransport?.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });
    } catch (error) {
      console.error(`Consume failed`, error);

      return;
    }

    if (!consumer) {
      return;
    }

    this.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => {
      if (!consumer) {
        return;
      }

      console.log(`Consumer transport close`, {
        name: this.name,
        consumerId: consumer.id,
      });
      this.consumers.delete(consumer.id);
    });

    return {
      consumer,
      params: {
        producerId,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused,
      },
    };
  }

  closeProducer(producerId: string) {
    try {
      this.producers.get(producerId)?.close();
    } catch (e) {
      console.warn(e);
    }

    this.producers.delete(producerId);
  }

  getProducer(producerId: string) {
    return this.producers.get(producerId);
  }

  close() {
    for (const transport of this.transports.values()) {
      transport.close();
    }
  }

  removeConsumer(consumerId: string) {
    this.consumers.delete(consumerId);
  }
}
