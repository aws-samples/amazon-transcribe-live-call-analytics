# Supplementary Amazon Chime Voice Connector Resources for Demonstration

An Asterisk server can be built on EC2 as part of this demo. This Asterisk server will act as a PBX that can be used to generate calls or play a sample audio file to answer calls.

Alternatively, an Amazon Chime Voice Connector can be built that will allow you to use your existing SBC to send a SIPREC SIP INVITE to the Voice Connector.

### With Asterisk Server

![Diagram](images/Asterisk-Overview.png)

For more [information](Asterisk.md) on using the Asterisk server with LCA.

### With Existing SBC and SIPREC

![Diagram](images/SIPREC-Overview.png)

For more [information](SIPREC.md) on using SIPREC with LCA.

### Notes

- In these example deployments, UDP is used as the SIP protocol and RTP is unencrypted. In production environments, TLS/SRTP can be used to secure signaling and media between your SBC and the Chime Voice Connector. This will require additional configuration on your SIP devices.
