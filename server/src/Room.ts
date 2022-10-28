import mediasoup from 'mediasoup';
import socketio from 'socket.io';
import { config } from './config';
import { Peer } from './Peer';

export class Room {
  peers: Map<string, Peer> = new Map();
  router: mediasoup.types.Router | null = null;

  constructor(
    readonly id: string,
    worker: mediasoup.types.Worker,
    readonly io: socketio.Server,
  ) {
    this.initRouter(worker);
  }

  private async initRouter(worker: mediasoup.types.Worker) {
    const router = await worker.createRouter({
      mediaCodecs: config.mediasoup.router
        .mediaCodecs as mediasoup.types.RtpCodecCapability[],
    });

    this.router = router;
  }

  addPeer(peer: Peer) {
    this.peers.set(peer.id, peer);
  }

  removePeer(socketId: string) {
    this.peers.get(socketId)?.close();
    this.peers.delete(socketId);
  }

  getProducerListForPeer() {
    const producers: string[] = [];

    for (const peer of this.peers.values()) {
      for (const producer of peer.producers.values()) {
        producers.push(producer.id);
      }
    }

    return producers;
  }

  getRtpCapabilities() {
    return this.router?.rtpCapabilities;
  }

  async createWebRtcTransport(socketId: string) {
    const { maxIncomingBitrate, initialAvailableOutgoingBitrate } =
      config.mediasoup.webRtcTransport;

    if (!this.router) {
      return null;
    }

    const transport = await this.router.createWebRtcTransport({
      listenIps: config.mediasoup.webRtcTransport.listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate,
    });

    if (maxIncomingBitrate) {
      try {
        await transport.setMaxIncomingBitrate(maxIncomingBitrate);
      } catch {}
    }

    transport.on('dtlsstatechange', (dtlsState) => {
      if (dtlsState === 'closed') {
        console.log('Transport close', {
          name: this.peers.get(socketId)?.name,
        });
        transport.close();
      }
    });

    console.log('Adding transport', { transportId: transport.id });

    this.peers.get(socketId)?.addTransport(transport);

    return {
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    };
  }

  async connectPeerTransport(
    socketId: string,
    transportId: string,
    dtlsParameters: mediasoup.types.DtlsParameters,
  ) {
    if (!this.peers.has(socketId)) {
      return;
    }

    await this.peers
      .get(socketId)
      ?.connectTransport(transportId, dtlsParameters);
  }

  async produce(
    socketId: string,
    producerTransportId: string,
    rtpParameters: mediasoup.types.RtpParameters,
    kind: mediasoup.types.MediaKind,
  ) {
    try {
      const producer = await this.peers
        .get(socketId)
        ?.createProducer(producerTransportId, rtpParameters, kind);

      if (!producer) {
        return;
      }

      this.broadcast(socketId, 'newProducers', [
        {
          producerId: producer.id,
          producerSocketId: socketId,
        },
      ]);

      return producer.id;
    } catch {}
  }

  async consume(
    socketId: string,
    consumerTransportId: string,
    producerId: string,
    rtpCapabilities: mediasoup.types.RtpCapabilities,
  ) {
    if (
      !this.router ||
      !this.router.canConsume({
        producerId,
        rtpCapabilities,
      })
    ) {
      console.error(`router can't consume,`, producerId, rtpCapabilities);
      return;
    }

    const consumer = await this.peers
      .get(socketId)
      ?.createConsumer(consumerTransportId, producerId, rtpCapabilities);

    if (!consumer) {
      console.error('consumer not found');
      return;
    }

    consumer.consumer.on('producerclose', () => {
      console.log('Consumer closed due to producerclose event', {
        name: `${this.peers.get(socketId)?.name}`,
        consumer_id: `${consumer.consumer.id}`,
      });
      this.peers.get(socketId)?.removeConsumer(consumer.consumer.id);
      // tell client consumer is dead
      this.io.to(socketId).emit('consumerClosed', {
        consumer_id: consumer.consumer.id,
      });
    });

    return consumer.params;
  }

  closeProducer(socketId: string, producerId: string) {
    this.peers.get(socketId)?.closeProducer(producerId);
  }

  broadcast(socketId: string, name: string, data: any) {
    const otherPeers = [...this.peers.keys()].filter((id) => id !== socketId);

    for (const otherId of otherPeers) {
      this.send(otherId, name, data);
    }
  }

  send(socketId: string, name: string, data: any) {
    this.io.to(socketId).emit(name, data);
  }

  getPeers() {
    return this.peers;
  }

  toJson() {
    return {
      id: this.id,
      peers: JSON.stringify([...this.peers]),
    };
  }
}
