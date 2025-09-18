export const networks = {
    local: {
        url: 'http://127.0.0.1:9000',
        name: 'local'
    },
    devnet: {
        url: 'https://fullnode.devnet.sui.io:443',
        name: 'devnet'
    },
    testnet: {
        url: 'https://sui-testnet-rpc.publicnode.com',
        name: 'testnet'
    },
    mainnet: {
        url: 'https://fullnode.mainnet.sui.io:443',
        name: 'mainnet'
    }
};

export const defaultNetwork = 'local';

export function getNetwork(networkName?: string) {
    const network = networkName || defaultNetwork;
    if (!networks[network as keyof typeof networks]) {
        throw new Error(`Network ${network} not found`);
    }
    return networks[network as keyof typeof networks];
}