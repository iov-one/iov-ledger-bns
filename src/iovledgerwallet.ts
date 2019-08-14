// tslint:disable:readonly-array
import {
  Algorithm,
  ChainId,
  Identity,
  PrehashType,
  PubkeyBytes,
  SignableBytes,
  SignatureBytes,
} from "@iov/bcp";
import { Ed25519Keypair, Slip10RawIndex } from "@iov/crypto";
import { Encoding } from "@iov/encoding";
import {
  Keyring,
  Wallet,
  WalletId,
  WalletImplementationIdString,
  WalletSerializationString,
} from "@iov/keycontrol";
import { DefaultValueProducer, ValueAndUpdates } from "@iov/stream";
import PseudoRandom from "random-js";
import { As } from "type-tagger";

import { getPublicKeyWithIndex, signTransactionWithIndex } from "./app";
import { connectToFirstLedger } from "./exchange";
import { LedgerState, StateTracker } from "./statetracker";

interface PubkeySerialization {
  readonly algo: string;
  readonly data: string;
}

interface LocalIdentitySerialization {
  readonly chainId: string;
  readonly pubkey: PubkeySerialization;
  readonly label?: string;
}

interface IdentitySerialization {
  readonly localIdentity: LocalIdentitySerialization;
  readonly simpleAddressIndex: number;
}

interface IovLedgerWalletSerialization {
  readonly formatVersion: number;
  readonly id: string;
  readonly label: string | undefined;
  readonly identities: ReadonlyArray<IdentitySerialization>;
}

function deserialize(data: WalletSerializationString): IovLedgerWalletSerialization {
  const doc = JSON.parse(data);
  const formatVersion = doc.formatVersion;

  if (typeof formatVersion !== "number") {
    throw new Error("Expected property 'formatVersion' of type number");
  }

  // Case distinctions / migrations based on formatVersion go here
  switch (formatVersion) {
    case 1:
      throw new Error(
        "Wallet format version 1 detected. " +
          "No automatic migration is possible from that format since it is missing chain IDs in identities. " +
          "Use IOV-Core 0.9 or 0.10 to export the secret and re-create wallet in IOV-Core 0.11+.",
      );
    case 2:
      break;
    default:
      throw new Error(`Got unsupported format version: '${formatVersion}'`);
  }

  // other checks

  const id = doc.id;
  if (typeof id !== "string") {
    throw new Error("Expected property 'id' of type string");
  }

  if (!id.match(/^[a-zA-Z0-9]+$/)) {
    throw new Error(`Property 'id' does not match expected format. Got: '${id}'`);
  }

  return doc;
}

type IdentityId = string & As<"identity-id">;

export class IovLedgerWallet implements Wallet {
  public static readonly implementationId = "ledger-simpleaddress" as WalletImplementationIdString;

  /**
   * A convenience function to register this wallet type with the global Keyring class
   */
  public static registerWithKeyring(): void {
    const implId = IovLedgerWallet.implementationId;
    Keyring.registerWalletType(implId, (data: WalletSerializationString) => {
      return new IovLedgerWallet(data);
    });
  }

  private static readonly idPool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  private static readonly idsPrng: PseudoRandom.Engine = PseudoRandom.engines.mt19937().autoSeed();

  private static generateId(): WalletId {
    // this can be pseudo-random, just used for internal book-keeping
    const code = PseudoRandom.string(IovLedgerWallet.idPool)(IovLedgerWallet.idsPrng, 16);
    return code as WalletId;
  }

  private static identityId(identity: Identity): IdentityId {
    const id = [identity.chainId, identity.pubkey.algo, Encoding.toHex(identity.pubkey.data)].join("|");
    return id as IdentityId;
  }

  public readonly id: WalletId;
  public readonly label: ValueAndUpdates<string | undefined>;
  public readonly canSign: ValueAndUpdates<boolean>;
  public readonly implementationId = IovLedgerWallet.implementationId;
  public readonly deviceState: ValueAndUpdates<LedgerState>;

  // wallet
  private readonly deviceTracker = new StateTracker();
  private readonly labelProducer: DefaultValueProducer<string | undefined>;
  private readonly canSignProducer: DefaultValueProducer<boolean>;

  // identities
  private readonly identities: Identity[];
  private readonly labels: Map<IdentityId, string | undefined>;
  private readonly simpleAddressIndices: Map<IdentityId, number>;

  constructor(data?: WalletSerializationString) {
    this.canSignProducer = new DefaultValueProducer(false);
    this.canSign = new ValueAndUpdates(this.canSignProducer);

    this.deviceTracker.state.updates.subscribe({
      next: (value: LedgerState) => {
        this.canSignProducer.update(value === LedgerState.IovAppOpen);
      },
    });
    this.deviceState = this.deviceTracker.state;

    let id: WalletId;
    let label: string | undefined;
    const identities: Identity[] = [];
    const simpleAddressIndices = new Map<IdentityId, number>();
    const labels = new Map<IdentityId, string | undefined>();

    if (data) {
      const decodedData = deserialize(data);

      // id
      id = decodedData.id as WalletId;

      // label
      label = decodedData.label;

      // identities
      for (const record of decodedData.identities) {
        const identity = this.buildIdentity(
          record.localIdentity.chainId as ChainId,
          Encoding.fromHex(record.localIdentity.pubkey.data) as PubkeyBytes,
        );
        identities.push(identity);
        simpleAddressIndices.set(IovLedgerWallet.identityId(identity), record.simpleAddressIndex);
        labels.set(IovLedgerWallet.identityId(identity), record.localIdentity.label);
      }
    } else {
      id = IovLedgerWallet.generateId();
    }

    this.id = id;
    this.labelProducer = new DefaultValueProducer<string | undefined>(label);
    this.label = new ValueAndUpdates(this.labelProducer);
    this.identities = identities;
    this.simpleAddressIndices = simpleAddressIndices;
    this.labels = labels;
  }

  /**
   * Turn on tracking USB devices.
   *
   * This is must be called before every hardware interaction,
   * i.e. createIdentity() and createTransactionSignature() and to
   * use the canSign and deviceState properties.
   */
  public startDeviceTracking(): void {
    this.deviceTracker.start();
  }

  /**
   * Turn off tracking USB devices.
   *
   * Use this to save resources when IovLedgerWallet is not used anymore.
   * With device tracking turned off, canSign and deviceState are not updated anymore.
   */
  public stopDeviceTracking(): void {
    this.deviceTracker.stop();
  }

  public setLabel(label: string | undefined): void {
    this.labelProducer.update(label);
  }

  public async createIdentity(chainId: ChainId, options: unknown): Promise<Identity> {
    if (typeof options !== "number") {
      throw new Error("Expected numeric argument");
    }
    const index = options;

    if (!this.deviceTracker.running) {
      throw new Error("Device tracking off. Did you call startDeviceTracking()?");
    }

    await this.deviceState.waitFor(LedgerState.IovAppOpen);

    const transport = await connectToFirstLedger();

    const pubkey = await getPublicKeyWithIndex(transport, index);
    const newIdentity = this.buildIdentity(chainId, pubkey as PubkeyBytes);
    const newIdentityId = IovLedgerWallet.identityId(newIdentity);

    if (this.identities.find(i => IovLedgerWallet.identityId(i) === newIdentityId)) {
      throw new Error(
        "Identity Index collision: this happens when you try to create multiple identities with the same index in the same wallet.",
      );
    }

    this.identities.push(newIdentity);
    this.simpleAddressIndices.set(newIdentityId, index);
    this.labels.set(newIdentityId, undefined);

    return newIdentity;
  }

  public setIdentityLabel(identity: Identity, label: string | undefined): void {
    const identityId = IovLedgerWallet.identityId(identity);
    const index = this.identities.findIndex(i => IovLedgerWallet.identityId(i) === identityId);
    if (index === -1) {
      throw new Error("identity with id '" + identityId + "' not found");
    }

    this.labels.set(identityId, label);
  }

  public getIdentityLabel(identity: Identity): string | undefined {
    const identityId = IovLedgerWallet.identityId(identity);
    const index = this.identities.findIndex(i => IovLedgerWallet.identityId(i) === identityId);
    if (index === -1) {
      throw new Error("identity with id '" + identityId + "' not found");
    }

    return this.labels.get(identityId);
  }

  public getIdentities(): ReadonlyArray<Identity> {
    // copy array to avoid internal updates to affect caller and vice versa
    return [...this.identities];
  }

  public async createTransactionSignature(
    identity: Identity,
    transactionBytes: SignableBytes,
    prehashType: PrehashType,
  ): Promise<SignatureBytes> {
    if (prehashType !== PrehashType.Sha512) {
      throw new Error("Only prehash type sha512 is supported on the Ledger");
    }

    if (!this.deviceTracker.running) {
      throw new Error("Device tracking off. Did you call startDeviceTracking()?");
    }

    await this.deviceState.waitFor(LedgerState.IovAppOpen);

    const simpleAddressIndex = this.simpleAddressIndex(identity);
    const transport = await connectToFirstLedger();

    const signature = await signTransactionWithIndex(transport, transactionBytes, simpleAddressIndex);
    return signature as SignatureBytes;
  }

  public printableSecret(): string {
    throw new Error("Extracting the secret from a hardware wallet is not possible");
  }

  public serialize(): WalletSerializationString {
    const out: IovLedgerWalletSerialization = {
      formatVersion: 2,
      label: this.label.value,
      id: this.id,
      identities: this.identities.map(identity => {
        const simpleAddressIndex = this.simpleAddressIndex(identity);
        const label = this.getIdentityLabel(identity);
        return {
          localIdentity: {
            chainId: identity.chainId,
            pubkey: {
              algo: identity.pubkey.algo,
              data: Encoding.toHex(identity.pubkey.data),
            },
            label: label,
          },
          simpleAddressIndex: simpleAddressIndex,
        };
      }),
    };
    return JSON.stringify(out) as WalletSerializationString;
  }

  public clone(): Wallet {
    return new IovLedgerWallet(this.serialize());
  }

  public async previewIdentity(
    _chainId: ChainId,
    _options: Ed25519Keypair | ReadonlyArray<Slip10RawIndex> | number,
  ): Promise<Identity> {
    throw new Error("Not yet implemented");
  }

  // This throws an exception when address index is missing
  private simpleAddressIndex(identity: Identity): number {
    const identityId = IovLedgerWallet.identityId(identity);
    const out = this.simpleAddressIndices.get(identityId);
    if (out === undefined) {
      throw new Error("No address index found for identity '" + identityId + "'");
    }
    return out;
  }

  private buildIdentity(chainId: ChainId, bytes: PubkeyBytes): Identity {
    if (!chainId) {
      throw new Error("Got empty chain ID when tying to build a local identity.");
    }

    const identity: Identity = {
      chainId: chainId,
      pubkey: {
        algo: Algorithm.Ed25519, // hardcoded until we support more curves in the ledger app
        data: bytes,
      },
    };
    return identity;
  }
}
