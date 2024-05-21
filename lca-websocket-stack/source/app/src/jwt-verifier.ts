import { FastifyRequest, FastifyReply } from 'fastify';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import dotenv from 'dotenv';
import { normalizeErrorForLogging } from './utils';
dotenv.config();

const USERPOOL_ID = process.env['USERPOOL_ID'] || '';
const cognitoJwtVerifier = CognitoJwtVerifier.create({
    userPoolId: USERPOOL_ID,
});

type queryobj = {
    authorization: string
};

type headersobj = {
    authorization: string
};

export const jwtVerifier = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as queryobj;
    const headers = request.headers as headersobj;
    const auth = query.authorization || headers.authorization;

    if (!auth) {
        request.log.error(`[AUTH]: [${request.socket.remoteAddress}] - No authorization query string or header found. URI: <${request.url}>, Headers: ${JSON.stringify(request.headers)}`);

        return reply.status(401).send();
    }

    const match = auth?.match(/^Bearer (.+)$/);
    if (!match) {
        request.log.error(`[AUTH]: [${request.socket.remoteAddress}] - No Bearer token found in header or query string. URI: <${request.url}>, Headers: ${JSON.stringify(request.headers)}`);

        return reply.status(401).send();
    }

    const accessToken = match[1];
    try {
        const payload = await cognitoJwtVerifier.verify(accessToken, { clientId: null, tokenUse: 'access' });      
        if (!payload) {
            request.log.error(`[AUTH]: [${request.socket.remoteAddress}] - Connection not authorized. Returning 401. URI: <${request.url}>, Headers: ${JSON.stringify(request.headers)}`);

            return reply.status(401).send();
        }
        request.log.info(`[AUTH]: [${request.socket.remoteAddress}] - Connection request authorized. URI: <${request.url}>, Headers: ${JSON.stringify(request.headers)}`);

        return;
    } catch (err) {
        request.log.error(`[AUTH]: [${request.socket.remoteAddress}] - Error Authorizing client connection. ${normalizeErrorForLogging(err)} URI: <${request.url}>, Headers: ${JSON.stringify(request.headers)}`);

        return reply.status(401).send();
    }
};



