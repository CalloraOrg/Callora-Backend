import dotenv from 'dotenv';

dotenv.config();

export type NetworkType = 'testnet' | 'mainnet';

export interface NetworkConfig {
    horizonUrl: string;
    rpcUrl: string;
    vaultContractId: string;
    settlementContractId: string;
    passphrase: string;
}

const NETWORK: NetworkType = (process.env.STELLAR_NETWORK || process.env.SOROBAN_NETWORK || 'testnet') as NetworkType;

const configs: Record<NetworkType, NetworkConfig> = {
    testnet: {
        horizonUrl: process.env.TESTNET_HORIZON_URL || 'https://horizon-testnet.stellar.org',
        rpcUrl: process.env.TESTNET_RPC_URL || 'https://soroban-testnet.stellar.org',
        vaultContractId: process.env.TESTNET_VAULT_CONTRACT_ID || '',
        settlementContractId: process.env.TESTNET_SETTLEMENT_CONTRACT_ID || '',
        passphrase: 'Test SDF Network ; September 2015',
    },
    mainnet: {
        horizonUrl: process.env.MAINNET_HORIZON_URL || 'https://horizon.stellar.org',
        rpcUrl: process.env.MAINNET_RPC_URL || 'https://soroban-rpc.mainnet.stellar.org', // Placeholder for common mainnet RPC
        vaultContractId: process.env.MAINNET_VAULT_CONTRACT_ID || '',
        settlementContractId: process.env.MAINNET_SETTLEMENT_CONTRACT_ID || '',
        passphrase: 'Public Global Stellar Network ; October 2015',
    },
};

export const config = {
    port: process.env.PORT || 3000,
    network: NETWORK,
    ...configs[NETWORK],
};

console.log(`Starting in ${config.network} mode`);
console.log(`Horizon URL: ${config.horizonUrl}`);
console.log(`RPC URL: ${config.rpcUrl}`);
