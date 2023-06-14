#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import pino from 'pino';

import fsp from 'node:fs/promises';

import Fastify from 'fastify';

import * as TOML from '@ltd/j-toml';

import { DoorbellConfig, MqttConfig } from './config';
import { Doorbell, StreamState } from './doorbell';
import { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { SipServer } from './sip_server';
import MQTT from 'async-mqtt';
import { hostname } from 'node:os';

const log = pino({
    transport: {
        target: 'pino-pretty'
    }, options : {
        sync: true
    }
    
})

if (process.argv.length != 3) 
{
    console.log("usage: ./server.ts <config.toml path>");
    process.exit(-1);
}


log.info("Starting up. Loading configuiration from %s", process.argv[2]);

const config = TOML.parse(await fsp.readFile(process.argv[2], 'utf-8')) as any;

const mqttConfig = config.mqtt as MqttConfig;

const mqtt = await MQTT.connectAsync({ 
    host: mqttConfig.broker, 
    port : Number(mqttConfig.port), 
    username: mqttConfig.username, 
    password: mqttConfig.password, 
    protocol: mqttConfig.protocol,
    will: {
        topic: `${mqttConfig.topic}/status`,
        payload: 'offline',
        retain: true
    }
    });

const doorbells = new Map<string,Doorbell>();

for (const [name, doorbell] of Object.entries(config["doorbell"]) as [string, DoorbellConfig][]) {
    doorbells.set(name, new Doorbell(name, doorbell, log.child({ doorbell : name}), { client: mqtt, config: mqttConfig} ));
    log.info("Loaded doorbell.%s (%s) at %s", name, doorbell.name, doorbell.address);
}

const fastify = Fastify({
    logger: log
});

fastify.addContentTypeParser('application/octet-stream', async function (request : any, payload : IncomingMessage) {
    return new Response(Readable.toWeb(payload)).arrayBuffer();
})

fastify.get<{
    Reply: { status : "OK" }
}>('/status', (req) => {
    return { status : "OK"}
});

fastify.get<{
    Reply: { devices : string[] }
}>('/list', (req) => {
    return { devices : Array.from(doorbells.keys()) }
});

fastify.get<{
    Params: { doorbell : string},
    Reply: { status : "OK",  state: "playing" | "idle" } | { status : "ERROR", error: string}
}>('/:doorbell/info', (req) => {
    log.info("Doorbell %s info", req.params.doorbell);

    try {
        const doorbell = doorbells.get(req.params.doorbell);
            
        if (!doorbell) {
            throw new Error("Doorbell not found");
        }

        return { status : "OK", state: doorbell.outputStreamState === StreamState.PLAYING ? "playing" : "idle"}
    } catch (e) {
        log.error(e, "info for doorbell %s ended with error", req.params.doorbell);
        return {
            status: "ERROR",
            error : (e as Error).message
        }
    }
});

fastify.post<{
    Params: { doorbell : string},
    Reply: { status : "OK" } | { status : "ERROR", error: string}
}>('/:doorbell/stop', async (req) => {
    log.info("Doorbell %s stop", req.params.doorbell);


    try {
        const doorbell = doorbells.get(req.params.doorbell);
            
        if (!doorbell) {
            throw new Error("Doorbell not found");
        }

        await doorbell.stopAudio();

        return { status : "OK"}
    } catch (e) {
        log.error(e, "play url for doorbell %s ended with error", req.params.doorbell);
        return {
            status: "ERROR",
            error : (e as Error).message
        }
    }
});

fastify.post<{
    Params: { doorbell : string},
    Body: { media_id : string},
    Reply: { status : "OK" } | { status : "ERROR", error: string}
}>('/:doorbell/play', async (req) => {
    log.info("Doorbell %s media_id %s", req.params.doorbell, req.body.media_id);

    try {
        const doorbell = doorbells.get(req.params.doorbell);
            
        if (!doorbell) {
        throw new Error("Doorbell not found");
        }

        await doorbell.playAudioUrl(req.body.media_id);

        return { status : "OK"}
    } catch (e) {
        log.error(e, "play url for doorbell %s ended with error", req.params.doorbell);
        return {
            status: "ERROR",
            error : (e as Error).message
        }
    }
});

fastify.post<{
    Reply: { status : "OK" } | { status : "ERROR", error: string};
    Params: { doorbell : string};
}>('/:doorbell/simulateButtonPress', async (req) => {
    try {
        const doorbell = doorbells.get(req.params.doorbell);
        
        if (!doorbell) {
           throw new Error("Doorbell not found");
        }
   
        await doorbell.handleButtonPress();
   
        return {
           status: "OK"
        }
       } catch (e) {
           log.error(e, "simulate button press for doorbell %s ended with error", req.params.doorbell);
           return {
               status: "ERROR",
               error: (e as Error).message
           }
       }
})
  
fastify.post<{
    Body: ArrayBuffer
    Reply: { status : "OK" } | { status : "ERROR", error: string};
    Params: { doorbell : string};
  }>('/:doorbell/playAudioFile', async (req) => {
    try {
     const doorbell = doorbells.get(req.params.doorbell);
     
     if (!doorbell) {
        throw new Error("Doorbell not found");
     }

     await doorbell.playAudioFile(Buffer.from(req.body));

     return {
        status: "OK"
     }
    } catch (e) {
        log.error(e, "playAudioFile for doorbell %s ended with error", req.params.doorbell);
        return {
            status: "ERROR",
            error: (e as Error).message
        }
    }
})

fastify.listen({
    port: Number(config.server.http_port),
    host: "0.0.0.0"
});

const sipServer = new SipServer({port: Number(config.server.sip_port), doorbells, log});

try {
    await mqtt.publish(`${config.mqtt.topic}/status`, "online", {
        retain: true
    });

    await mqtt.publish(`${mqttConfig.ha_prefix}/binary_sensor/${mqttConfig.topic}/config`, JSON.stringify({
        name: "Hikvision Server",
        object_id: "hikvision_server",
        device : {
            name: "Hikvision Server",
            identifiers: [
                mqttConfig.unique_id
            ]
        },
        state_topic: `${config.mqtt.topic}/status`,
        payload_on: "online",
        payload_off: "offline",
        unique_id: mqttConfig.unique_id
    }),{retain : true}).catch(e=> log.error(e, "Error publishing MQTT HA Config"));
} catch (e) {
    log.error(e, "Failed to publish MQTT status topic");
}

