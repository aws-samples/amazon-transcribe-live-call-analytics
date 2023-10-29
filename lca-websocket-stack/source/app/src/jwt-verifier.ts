import { FastifyRequest, FastifyReply } from 'fastify';
import { CognitoJwtVerifier } from 'aws-jwt-verify';


const USERPOOL_ID = process.env['USERPOOL_ID'] || '';
const cognitoJwtVerifier = CognitoJwtVerifier.create({
    userPoolId: USERPOOL_ID,
});

type queryobj = {
    authorization: string
};

export const jwtVerifier = async (request: FastifyRequest, reply: FastifyReply) => {

    const { authorization }= request.query as queryobj;
    
    if (!authorization) {
        return reply.status(401).send();
    }

    const match = authorization?.match(/^Bearer (.+)$/);
    if (!match) {
        return reply.status(401).send();
    }

    const accessToken = match[1];
    try {
        const payload = await cognitoJwtVerifier.verify(accessToken, { clientId: null, tokenUse: 'access' });      
        if (!payload) {
            return reply.status(401).send();
        }
        request.log.info(`Connection request authorized at ${payload.auth_time}`);
        return;
    } catch (err) {
        request.log.error('Error Authorizing client connection ', err);
        return reply.status(401).send();
    }
};



