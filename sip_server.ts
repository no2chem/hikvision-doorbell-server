import dgram, {RemoteInfo, Socket} from 'node:dgram';
import { Doorbell } from './doorbell';
import { Logger } from 'pino';

export class SipServer {

    server : Socket;
    log : Logger;

    constructor ( public options : { port : number, doorbells : Map<string, Doorbell>, log: Logger} ) {
        this.log = options.log.child({server : "sip"});

        this.server = dgram.createSocket('udp4');

        this.server.on('error', (e) => {
            this.log.error(e);
            this.server.close();
        })

        this.server.on('message', (m, s) => this.handleMessage(m, s))

        this.server.bind(this.options.port, () => {
            this.log.info(`Starting SIP server on UDP ${this.server.address().address}:${this.server.address().port}`);
        })
    }

    userNameRegex = /sip:([^@]+)\@[^>]+/;

    handleMessage(m : Buffer, s: RemoteInfo) {
        const server = this;
        const msg = SipRequestMessage.parse(m.toString('utf8'));

        if (msg.data.method !== "") {
            this.log.debug("Incoming %s message: %s", msg.data.method, m.toString('utf8'));

            if (msg.data.method == "REGISTER") {
                const userName = msg.data.headers["To"].match(this.userNameRegex)![1];
                if (this.options.doorbells.has(userName)) {
                    this.log.info("Doorbell with username %s registered", userName);
                } else {
                    this.log.warn("Doorbell with username %s attempted REGISTER but not found (check config)", userName);
                }
                this.sendReply(s, msg, "200 OK", {
                    Contact: `<sip:${userName}@${s.address}:${s.port};transport=udp>;expires=3600`
                })
            } else if (msg.data.method == "INVITE") {
                const userName = msg.data.headers["From"].match(this.userNameRegex)![1];

                // Trigger doorbell press
                if (this.options.doorbells.has(userName)) {
                    this.options.doorbells.get(userName)?.handleButtonPress();
                } else {
                    this.log.warn("Doorbell with username %s pressed but not found!", userName);
                }
                const externalAddress = `${msg.data.headers["From"].split("@")[1].split(">")[0]}:${server.server.address().port}`;
                this.sendReply(s, msg, "100 Trying");
                this.sendReply(s, msg, "183 Session Progress", {
                    "Contact" : `<sip:${externalAddress}>`,
                    "Content-Type" : "application/sdp"
                },
                new SdpMessage([
                    ["v", "0"],
                    ["o", `- 2253 3984 IN IP4 ${externalAddress.split(":")[0]}`],
                    ["s", "fake"],
                    ["c", `IN IP4 ${externalAddress.split(":")[0]}`],
                    ["t", "0 0"],
                    ["a", "msid-semantic:WMS *"],
                    ["m", "audio 16852 RTP/AVP 0 8 98 96 101"],
                    ["a", "connection:new"],
                    ["a", "setup:actpass"],
                    ["a", "rtpmap:0 PCMU/8000"],
                    ["a", "rtpmap:8 PCMA/8000"],
                    ["a", "rtpmap:98 speex/8000"],
                    ["a", "rtpmap:96 opus/48000/2"],
                    ["a", "rtpmap:101 telephone-event/8000"],
                    ["a", "ftmp:101 0-16"],
                    ["a", "ptime:20"],
                    ["a", "maxptime:60"],
                    ["a", "sendrecv"]
                ]).toString()
                );
                this.sendReply(s, msg, "200 OK", {
                    "Contact" : `<sip:${externalAddress}>`,
                    "Content-Type" : "application/sdp"
                },
                new SdpMessage([
                    ["v", "0"],
                    ["o", `- 2253 3984 IN IP4 ${externalAddress.split(":")[0]}`],
                    ["s", "fake"],
                    ["c", `IN IP4 ${externalAddress.split(":")[0]}`],
                    ["t", "0 0"],
                    ["a", "msid-semantic:WMS *"],
                    ["m", "audio 16852 RTP/AVP 0 8 98 96 101"],
                    ["a", "connection:new"],
                    ["a", "setup:actpass"],
                    ["a", "rtpmap:0 PCMU/8000"],
                    ["a", "rtpmap:8 PCMA/8000"],
                    ["a", "rtpmap:98 speex/8000"],
                    ["a", "rtpmap:96 opus/48000/2"],
                    ["a", "rtpmap:101 telephone-event/8000"],
                    ["a", "ftmp:101 0-16"],
                    ["a", "ptime:20"],
                    ["a", "maxptime:60"],
                    ["a", "sendrecv"]
                ]).toString()
                );
            } else if (msg.data.method == "ACK") {
                this.sendRequest(s, msg, 'BYE', `sip:${s.address}:${s.port}`);
            } else if (msg.data.method == "BYE") {
                this.sendReply(s, msg, "200 OK");
            }
        }
    }

    sendRequest(remote : RemoteInfo, message : SipRequestMessage, method: "BYE", uri: string, extraHeaders?: {}, body? : string) {

        const branch = message.data.headers["Via"].split(';').filter(s => s.indexOf('=') !== -1).map(s => s.split('=')).filter(s => s[0] == "branch")[0][1];

        this.server.send(new SipRequestMessage(
            {method, uri, version: message.data.version, headers : {
                Via: `${message.data.version}/UDP ${remote.address}:${remote.port};branch=${branch};rport`,
                "Call-ID": message.data.headers["Call-ID"],
                From: `${message.data.headers["To"]}`,
                To: message.data.headers["From"],
                CSeq: `10 ${method}`,
                "Max-Forwards" : "70",
                "User-Agent" : "Asterisk PBX 18.14.0",
                "Content-Length" : body ? body.length.toString() : "0",
                ...extraHeaders}, body}
        ).toString(), remote.port, remote.address);
    }

   sendReply(remote : RemoteInfo, message : SipRequestMessage, status: "100 Trying" | "183 Session Progress" | "200 OK" | "503 Service Unavailable", extraHeaders?: {}, body? : string) {

        const branch = message.data.headers["Via"].split(';').filter(s => s.indexOf('=') !== -1).map(s => s.split('=')).filter(s => s[0] == "branch")[0][1];
        const sipRegex = /(sip:[^>]+)/g;

        this.server.send(new SipResponseMessage(
            {status, version: message.data.version, headers : {
                Via: `${message.data.version}/UDP ${remote.address}:${remote.port};rport=${remote.port};received=${remote.address};branch=${branch}`,
                "Call-ID": message.data.headers["Call-ID"],
                From: message.data.headers["From"],
                To: `<${message.data.headers["To"].match(sipRegex)![0]}>;tag=${branch}`,
                CSeq: message.data.headers["CSeq"],
                "Server" : "Asterisk PBX 18.14.0",
                "Content-Length" : body ? body.length.toString() : "0",
                ...extraHeaders}, body}
        ).toString(), remote.port, remote.address);
    }

}

class SdpMessage {

    constructor( 
        public data : [string,string][]) {}

    toString() { 
        return `${this.data.map(([k,v]) => `${k}=${v}`).join('\r\n')}\r\n`
    }
}

class SipRequestMessage {

    constructor(public data: {
        method : string,
        uri: string,
        version : string
        headers : { [name : string] : string },
        body? : string
    }) {

    }
    static parse(message : string) {
        const byLine = message.split('\r\n');
        const [method, uri, version] = byLine[0].split(" ");
        const headers = Object.fromEntries(byLine.slice(1).map(s => s.split(': ')));
        return new SipRequestMessage({method, uri, version, headers});
    }


    toString() {
        return `${this.data.method} ${this.data.uri} ${this.data.version}\r\n${Object.entries(this.data.headers).filter(h => h[1] !== undefined).map(header => `${header[0]}: ${header[1]}`).join('\r\n')}\r\n\r\n${this.data.body? this.data.body : ""}`;
    }  
}

class SipResponseMessage {

    constructor(public data : {
        status: string,
        version: string,
        headers : { [name : string] : string }
        body? : string
    }) {

    }

    toString() {
        return `${this.data.version} ${this.data.status}\r\n${Object.entries(this.data.headers).filter(h => h[1] !== undefined).map(header => `${header[0]}: ${header[1]}`).join('\r\n')}\r\n\r\n${this.data.body? this.data.body : ""}\r\n`;
    }   
}