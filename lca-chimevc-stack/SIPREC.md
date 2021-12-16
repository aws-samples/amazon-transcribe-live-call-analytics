# Using the SIPREC with Amazon Chime Voice Connector and Live Call Analytics Demo

![Diagram](images/SIPREC-Overview.png)

### Configuring Voice Connector with SIPREC

SIPREC connectivity to Amazon Chime Voice Connector offers a way to leverage your existing infrastructure with the features demonstrated here. Chime Voice Connector endpoints use public IP addresses, so your SBC must allow one-way, outbound connectivity to a range of these IPs defined [here](https://docs.aws.amazon.com/chime/latest/ag/network-config.html#cvc). This deployment includes an option to configure an Amazon Chime Voice Connector with streaming to be used as a SIPREC endpoint. Additionally, more information can be found [here](https://docs.aws.amazon.com/chime/latest/ag/start-kinesis-vc.html). A comma separated list of CIDR blocks (limit 10) can be entered that will be configured on the Chime Voice Connector. These CIDR blocks _must_ be public ranges and between a /27 and /32 in size.

#### SBC Configuration Examples

- [CUBE](CUBE_Config.md) Configuration Example
