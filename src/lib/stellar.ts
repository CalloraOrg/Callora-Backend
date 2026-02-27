import { Horizon, rpc } from 'stellar-sdk';
import { config } from '../config.js';

export const horizonServer = new Horizon.Server(config.horizonUrl);

export const sorobanServer = new rpc.Server(config.rpcUrl);

export const getNetworkPassphrase = () => config.passphrase;


export const buildDepositTx = async (
    sourceAddress: string,
    amount: string,
    assetCode: string,
    assetIssuer?: string
) => {
     console.log(`Building deposit tx for ${amount} ${assetCode} on ${config.network}`);

     const networkPassphrase = getNetworkPassphrase();

    return {
        network: config.network,
        vault: config.vaultContractId,
        settlement: config.settlementContractId,
        passphrase: networkPassphrase
    };
};

export const getContractClient = (contractId: string) => {
      return {
        server: sorobanServer,
        contractId,
        networkPassphrase: getNetworkPassphrase()
    };
};
