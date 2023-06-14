import { DoorbellConfig, MqttConfig } from './config';

import { Readable, PassThrough, Stream } from 'node:stream'

import pino from 'pino';
import DigestFetch from "digest-fetch";

import child_process from 'node:child_process';
import AsyncLock from 'async-lock';

import MQTT from 'async-mqtt';

export enum StreamState {
    STOPPED,
    STOPPING,
    RESTARTING,
    PLAYING
}

const fulfilledPromise = () => {
    return new Promise<void>((r) => r())
};

const delay = (ms : number, signal? : AbortSignal) => new Promise<void>((resolve, reject) => {
    const abortHandler = (event : Event) => {
        clearTimeout(timer);
        reject(signal?.reason);
    };

    let timer = setTimeout(() => {
        resolve();
        signal?.removeEventListener("abort", abortHandler);
    }, ms)

    signal?.addEventListener("abort", abortHandler);
});

export class Doorbell {


    lock = new AsyncLock();

    outputStreamPromise : Promise<void> = fulfilledPromise();
    outputStreamAbortController = new AbortController();
    outputStreamState = StreamState.STOPPED;
    outputStream : Readable | undefined = undefined;

    constructor(public key: string, public config : DoorbellConfig, public log : pino.Logger, public mqtt: { client: MQTT.AsyncClient, config : MqttConfig } ) {
        mqtt.client.publish(this.getMqttTopic('status'), "ready", {retain : true})
            .catch(e=> this.log.error(e, "Error publishing MQTT"))

        mqtt.client.publish(`${mqtt.config.ha_prefix}/device_automation/${mqtt.config.topic}/doorbell_${key}/config`, JSON.stringify({
            name: key,
            automation_type: 'trigger',
            type: "button_short_press",
            subtype: "doorbell",
            device : {
                identifiers: [
                    `${mqtt.config.unique_id}_doorbell_${key}`
                ],
                manufacturer: 'hikvision',
                name: config.name},
            payload: "pressed",
            topic: this.getMqttTopic("status"),
            unique_id: `${mqtt.config.unique_id}_doorbell_${key}`
        }),{retain : true}).catch(e=> this.log.error(e, "Error publishing MQTT HA Config"));
    }

    private getMqttTopic(topic: string) {
        return `${this.mqtt.config.topic}/doorbells/${this.key}/${topic}`;
    }

    async handleButtonPress() {
        this.log.info("Handling doorbell button press");

        this.mqtt.client.publish(this.getMqttTopic('status'), "pressed")
            .catch(e=> this.log.error(e, "Error publishing MQTT pressed Status"))

        if (this.outputStreamState == StreamState.PLAYING && this.outputStream) {
            this.log.info("Restarting output stream.");
            // If audio was playing; restart the current stream (wait 1s)
            this.outputStreamState = StreamState.RESTARTING;
            this.outputStreamAbortController.abort();
            await this.outputStreamPromise;
            await delay(1000);
            this.playStream(this.outputStream);
        } 
    }

    async stopAudio() {
        await this.lock.acquire('output', async () => {
            // Stop any current playing / paused streams
            if (this.outputStreamState != StreamState.STOPPED) {
                this.outputStreamState = StreamState.STOPPING;
                this.outputStreamAbortController.abort();
            }

            await this.outputStreamPromise;
            if (this.outputStreamState != StreamState.STOPPED) {
                this.log.warn("Expected output stream to be stopped after aborting but got %s", this.outputStreamState);
                throw new Error("Failed to stop output stream!");
            }

        });
    }
    
    async playStream(stream : Readable) {
        await this.lock.acquire('output', async () => {
            // Stop any current playing / paused streams
            if (this.outputStreamState != StreamState.STOPPED) {
                this.outputStreamState = StreamState.STOPPING;
                this.outputStreamAbortController.abort();
            }

            await this.outputStreamPromise;
            if (this.outputStreamState != StreamState.STOPPED) {
                this.log.warn("Expected output stream to be stopped after aborting but got %s", this.outputStreamState);
                throw new Error("Failed to stop output stream!");
            }

            this.outputStreamAbortController = new AbortController();
            const signal = this.outputStreamAbortController.signal;

            this.outputStream = stream;
            const client = new DigestFetch(this.config.user, this.config.password);

            // Start the output stream
            this.outputStreamPromise = (async() => {
                try {
                    this.outputStreamState = StreamState.PLAYING;
                    this.log.info("Starting output stream playback");

                     // close any existing session
                    await client.fetch(new URL("/ISAPI/System/TwoWayAudio/channels/1/close", this.config.address).href, {
                        method: 'PUT'
                    })
            
                    // start a new session
                    await client.fetch(new URL("/ISAPI/System/TwoWayAudio/channels/1/open", this.config.address).href, {
                        method: 'PUT'
                    })

                    // Passthrough for slowly consuming the main stream
                    let passthrough = new PassThrough();

                    client.fetch(new URL("/ISAPI/System/TwoWayAudio/channels/1/audioData", this.config.address).href, {
                        headers: {
                            "Content-Type" : "application/octet-stream",
                            "Connection" : "keep-alive",
                            "Content-Length" : "0"
                        },
                        method: 'PUT',
                        // @ts-ignore
                        body: passthrough,
                        signal
                    }); 
            
                    const delayTime = 1000 / (Number(this.config.outgoing_sample_rate) / Number(this.config.packet_size));

                    let packet : Buffer | null = null;

                    while(
                        // Either there is a packet available to be read, or the stream is not closed
                        (packet = await stream.read(Number(this.config.packet_size))) != null || !stream.closed
                        // And we haven't been stopped
                        && this.outputStreamState === StreamState.PLAYING) {
  
                        if (packet != null) {
                           passthrough.push(packet);
                        }
                        await delay(delayTime, signal);
                    }

                } catch (e) {
                    // If aborted, will throw domexception with aborted reason
                    if (e instanceof DOMException && e.code !== DOMException.ABORT_ERR) {
                        this.log.warn(e, "Unknown exception caught during stream playback");
                    }
                }
                finally {
                    this.log.info("closing");
                    if (this.outputStreamState === StreamState.PLAYING) {
                        // reached the end of the stream
                        stream.destroy();
                    }
                    // close the session
                    await client.fetch(new URL("/ISAPI/System/TwoWayAudio/channels/1/close", this.config.address).href, {
                        method: 'PUT'
                    })
                    this.outputStreamState = StreamState.STOPPED;
                }
            })();
        });

        await this.outputStreamPromise;
    }

   async playAudioUrl(audioUrl: string) {
        this.log.debug("Playing audio from url %s", audioUrl);

        const ffmpeg = child_process.spawn('ffmpeg', ['-hide_banner', '-i', audioUrl, '-vn', '-ar', this.config.outgoing_sample_rate.toString(), '-ac', '1', '-acodec', 'pcm_mulaw', '-f', 'mulaw', 'pipe:3'], {
            stdio: ['pipe', 'pipe', 'pipe', 'pipe']
        });

        ffmpeg.stdout.on('data', (d : Buffer) => this.log.debug(d.toString('utf8')));
        ffmpeg.stderr.on('data', (d : Buffer) => this.log.debug(d.toString('utf8')));

        const outputStream = ffmpeg.stdio[3] as Readable;
        let ps = new PassThrough();
        outputStream.pipe(ps);

        this.playStream(ps);
   }

   playAudioFile(audioFile: Buffer) {
        this.log.debug("Playing audio data of length %d", audioFile.byteLength);

        const ffmpeg = child_process.spawn('ffmpeg', ['-hide_banner', '-i', 'pipe:', '-vn', '-ar', this.config.outgoing_sample_rate.toString(), '-ac', '1', '-acodec', 'pcm_mulaw', '-f', 'mulaw', 'pipe:3'], {
            stdio: ['pipe', 'pipe', 'pipe', 'pipe']
        });

        ffmpeg.stdout.on('data', (d : Buffer) => this.log.debug(d.toString('utf8')));
        ffmpeg.stderr.on('data', (d : Buffer) => this.log.debug(d.toString('utf8')));

        const outputStream = ffmpeg.stdio[3] as Readable;

        const inputStream = Readable.from(audioFile);
        inputStream.pipe(ffmpeg.stdin);

        this.playStream(outputStream);

        // wait until the output is consumed
        return new Promise((resolve, reject) => {
            outputStream.on('finish', resolve);
            outputStream.on('error', reject);
        });
    }
}