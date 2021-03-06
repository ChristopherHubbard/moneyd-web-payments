import { createHmac, randomBytes } from 'crypto';

// This moneyd instance has a connection to the src/index.js in the moneyd package -- allows buildConfig and startConnector
const Connector = require('ilp-connector');
const fetch = require('node-fetch');
const { deriveKeypair, deriveAddress } = require('ripple-keypairs');
const { RippleAPI } = require('ripple-lib');
const { createSubmitter } = require('ilp-plugin-xrp-paychan-shared');

const connectorList = require('../config/connector_list.json');
const rippledList = require('../config/rippled_list.json');

const base64url = (buf: any) => buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

// Export the connector -- make this a type later -- there can only be one connector
let connector: any;
let pluginOptions: any;
let rippleApi: any;
let subscribed: boolean;
let ledgerSynced: boolean;

let uplinkType: string;
let testnet: boolean;

// Constants
const EXPIRE_TIME: number = 1000 * 60 * 60;
const SYNC_TIME: number = 1000 * 5;

export const getILPConnectorInfo = () =>
{
    if (!connector)
    {
        return undefined;
    }
    else
    {
        return {
            uplinkType,
            testnet: pluginOptions.testnet
        }
    }
}

export const createILPConnector = async (uplinkName: string, uplinkOptions: any) =>
{
    try
    {
        ledgerSynced = false;

        if (!connector)
        {
            await createConnector(uplinkName, uplinkOptions);
        }
        else
        {
            console.log('Shutting down existing connector');

            await stopILPConnector();

            await createConnector(uplinkName, uplinkOptions);
        }

        uplinkType = uplinkName;
        testnet = uplinkOptions.testnet;
    }
    catch (error)
    {
        console.error('Error creating the connector.');
        console.error(error);
    }
}

const createConnector = async (uplinkName: string, uplinkOptions: any) =>
{
    console.log('Creating ILP connector...');

    // Create the uplink data -- this will change depending on the uplinkName (XRP, ETH, etc) -- currently only supports XRP
    const uplinkData: any = await createUplinkData(uplinkName, uplinkOptions);

    // Create an ilp-connector -- moneyd just wraps this call, and this allows more flexibility
    connector = Connector.createApp({
        spread: 0,
        backend: 'one-to-one',
        store: 'ilp-store-memory',
        initialConnectTimeout: 60000,
        env: uplinkOptions.testnet ? 'test' : 'production',
        adminApi: !!uplinkOptions.adminApiPort,
        adminApiPort: uplinkOptions.adminApiPort,
        accounts: {
            parent: uplinkData,
            local: {
                relation: 'child',
                plugin: 'ilp-plugin-mini-accounts',
                assetCode: uplinkData.assetCode,
                assetScale: uplinkData.assetScale,
                balance: {
                    minimum: '-Infinity',
                    maximum: 'Infinity',
                    settleThreshold: '-Infinity'
                },
                options: {
                    wsOpts: { 
                        host: 'localhost',
                        port: uplinkOptions.connectorPort
                    },
                    allowedOrigins: uplinkOptions.allowedOrigins
                }
            }
        }
    });

    console.log('Created the connector');
}

export const startILPConnector = async () =>
{
    try
    {
        if (connector)
        {
            // List ledger as unsynced during the start -- should take a brief sync
            ledgerSynced = false;

            console.log('Starting the connector...');

            // Listen with the connector -- this essentially starts the service
            await connector.listen();

            console.log('Connector started...');

            // Set the timeout that allows the channels to be closed -- return channels?
            // Only 'Started' connector after syncing
            await new Promise((resolve) =>
            {
                setTimeout(() =>
                {
                    ledgerSynced = true;
                    resolve();
                }, SYNC_TIME);
            });
        }
        else
        {
            console.error('Connector does not exist');

            // What to do when connector doesnt exist??
        }
    }
    catch (error)
    {
        console.error('Error starting the connector. Is it already running?');
        console.error(error);

        // Restart the connector? -- what to do when a start fails?
    }
}

// Might be better to just have stop connector remove channels (if necessary) and then create a new connector from this image?
export const stopILPConnector = async () =>
{
    try
    {
        if (ledgerSynced)
        {
            console.log('Stopping the ILP connector...');

            // Shutdown the top level connector
            await connector.shutdown();

            // Remove all the channels
            await closeAllChannels();

            console.log('Connector stopped...');
        }
        else
        {
            console.error('Ledger not synced, cannot stop connector');
        }
    }
    catch (error)
    {
        console.error('Error stopping the connector');
        console.error(error);
    }
}

// Close all outstanding channels -- this is to cleanup channels so that they dont hold excess reserves
export const closeAllChannels = async () =>
{
    try
    {
        if (ledgerSynced)
        {
            // Get all the channels
            console.log('Closing all channels...');
            const channels = await getChannels();
            
            // Go through all the channels and close
            const submitter = await _submitter();
            for (const channel of channels)
            {
                await closeChannel(channel, submitter);
            }

            console.log('All channels closed');
        }
        else
        {
            console.error('Ledger not synced, cannot close channels');
        }
    }
    catch (error)
    {
        console.error(error);
    }
}

const closeChannel = async (channel: any, submitter: any) =>
{
    // Close the channel
    const channelId = channel.channel_id;
    console.log('Closing channel ' + channelId);

    try
    {
        await submitter.submit('preparePaymentChannelClaim', {
            channel: channelId,
            close: true
        });

        console.log('Payment Channel Claim complete');

        // Set a timer to close the channel on the hour -- how should this be handled? Cant block for 1 hr
        // Just wait? -- Even a new configure or shutdown should be fine as long as this closeChannel runs correctly at 1 hr
        setTimeout(async () =>
        {
            await closeChannel(channel, submitter);
        }, EXPIRE_TIME);
    }
    catch (error)
    {
        console.error('Warning for channel ' + channelId + ': ', error.message);
    }
}

// Get all the channels for an xrp connector
export const getChannels = async () =>
{
    const api = await _rippleApi();
    console.log('Fetching channels for address...');

    const res = await api.connection.request({
        command: 'account_channels',
        account: pluginOptions.address
    });

    return res.channels;
}

const _rippleApi = async () =>
{
    if (!rippleApi) 
    {
        rippleApi = new RippleAPI({ server: pluginOptions.xrpServer });
        await rippleApi.connect();
    }

    return rippleApi;
}

const _submitter = async () =>
{
    const api = await _rippleApi();

    if (!subscribed)
    {
        subscribed = true;
        await api.connection.request({
            command: 'subscribe',
            accounts: [ pluginOptions.address ]
        });
    }

    return createSubmitter(api, pluginOptions.address, pluginOptions.secret);
  }

const getAddress = (secret: string): string =>
{
    return deriveAddress(deriveKeypair(secret).publicKey);
}

// Add support for other uplink types (ETH, LND, COIL, etc)
const createUplinkData = async (uplinkName: string, uplinkOptions: any) =>
{
    // Only support XRP for now -- other uplinks later
    if (uplinkName === 'XRP')
    {
        // Configure the necessary options for the uplink data -- can even configure testnet with this
        const servers = connectorList[uplinkOptions.testnet ? 'test' : 'live'];
        const defaultParent = servers[Math.floor(Math.random() * servers.length)];
        const rippledServers = rippledList[uplinkOptions.testnet ? 'test' : 'live'];
        const defaultRippled = rippledServers[Math.floor(Math.random() * rippledServers.length)];

        let xrpAddress: string;
        let xrpSecret: string;

        if (uplinkOptions.testnet && !uplinkOptions.secret)
        {
            console.log('acquiring testnet account...');
            const resp = await fetch('https://faucet.altnet.rippletest.net/accounts', { method: 'POST' });
            const json = await resp.json();

            // Set the uplinkOptions secret no?
            xrpAddress = json.account.address;
            xrpSecret = json.account.secret;

            console.log('got testnet address "' + xrpAddress + '"');
            console.log('waiting for testnet API to fund address...');

            // Why is this here??
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
        else if (!uplinkOptions.testnet)
        {
            // This information should probably have validation
            xrpAddress = getAddress(uplinkOptions.secret);
            xrpSecret = uplinkOptions.secret;
        }
        else
        {
            // Address for testnet has to be passed in?
            xrpAddress = uplinkOptions.address;
            xrpSecret = uplinkOptions.secret;
        }

        const parentBtpHmacKey = 'parent_btp_uri';
        const btpName = base64url(randomBytes(32)) || '';
        const btpSecret = hmac(hmac(parentBtpHmacKey, defaultParent + btpName), xrpSecret).toString('hex');
        const btpServer = 'btp+wss://' + btpName + ':' + btpSecret + '@' + defaultParent;

        pluginOptions = {
            currencyScale: 9,
            server: btpServer,
            secret: xrpSecret,
            address: xrpAddress,
            xrpServer: defaultRippled
        };

        return {
            relation: 'parent',
            plugin: require.resolve('ilp-plugin-xrp-asym-client'),
            assetCode: 'XRP',
            assetScale: 9,
            balance: {
              minimum: '-Infinity',
              maximum: '20000000',
              settleThreshold: '5000000',
              settleTo: '10000000'
            },
            sendRoutes: false,
            receiveRoutes: false,
            options: pluginOptions
        };
    }
}

const hmac = (key: any, message: any) =>
{
    const h = createHmac('sha256', key);
    h.update(message);
    return h.digest();
}