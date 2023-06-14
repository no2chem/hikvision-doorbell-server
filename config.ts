export interface DoorbellConfig {
    name: string;
    user: string;
    password: string;
    address: string;
    outgoing_sample_rate: bigint;
    packet_size : bigint;
}

export interface MqttConfig {
    broker : string;
    port : bigint;
    username: string;
    password: string;
    topic: string;
    ha_prefix: string;
    unique_id : string;
    protocol: 'wss' | 'ws' | 'mqtt' | 'mqtts' | 'tcp' | 'ssl' | 'wx' | 'wxs';
}
