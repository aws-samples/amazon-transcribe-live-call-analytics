# Testing tools for Live Call Analytics - ChimeVC

These scripts will let you run a short test call (`call_test.sh`), a long test call (`call_2hr_test.sh`), and multiple concurrent calls (`conc_call_test.sh`).

It's simplest to these scripts on the ChimeVC Asterisk EC2 instance that is preinstalled with Live Call Analytics.

You can also run them on a standalone server, however, you will need to configure your network security group to allow traffic (copy the Asterisk security group), and also modify the list of IP CIDRS allowed to register with the Amazon Chime SDK Voice Connector.

## Steps

### Connecting to the Asterisk Server

To connect to the Asterisk server, please use [Session Manager](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/session-manager.html) within the EC2 console.

### Operate as root

Type `sudo bash` <enter> into the console and navigate to home with `cd ~` <enter>.

You can verify what directory you are in with `pwd`, which should be `/root`.

### Install build tools

`sudo yum groupinstall "Development Tools"`

### Install PJSIP

```shell
git clone https://github.com/pjsip/pjproject.git
pushd pjproject/
./configure && make dep && make clean && make
popd

```

### Download files to root folder of Asterisk EC2 instance

Get the scripts and recording by cloning the LCA repo

```shell
git clone https://github.com/aws-samples/amazon-transcribe-live-call-analytics.git
```

### Edit the variables in common.sh

Go to the scripts directory:

```shell
cd ./lca-chimevc-stack/asterisk-test-scripts
```

Edit the common.sh file with your favorite text editor.

Change the top three environment variables with the values from LCA:

1. `CALLER_VC_ENDPOINT`: This is your Amazon Chime SDK Voice Connector endpoint url. It can be found by navigating to the AWS Management Console > Amazon Chime > Voice Connectors > Outbound host name.
2. `CALLER_PHONE_NUMBER`: This is a 10 digit phone number of your choosing, that will emulate a caller.
3. `AGENT_PHONE_NUMBER`: This is the phone number of your LCA PBX installation. You can find it in the LCA CloudFormation output with the key `DemoPBXPhoneNumber`.

Example:

```shell
CALLER_VC_ENDPOINT='abcdefg.voiceconnector.chime.aws'
CALLER_PHONE_NUMBER='+1703AAABBBB'
AGENT_PHONE_NUMBER='+1618CCCDDDD'
```

### Run the scripts

Run any of the three scripts once they are edited to simulate phone calls. Do this by typing:

`sh ./call_test.sh`
OR
`sh ./conc_call_test.sh 20` to run 20 concurrent calls
