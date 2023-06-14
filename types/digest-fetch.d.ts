declare module 'digest-fetch' {
    class DigestFetch {
        constructor (username: string, password : string);
        fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    }

    export = DigestFetch;
}