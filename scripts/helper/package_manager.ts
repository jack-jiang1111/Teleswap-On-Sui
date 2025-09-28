import * as fs from 'fs';
import * as path from 'path';

export interface PackageIdStructure {
  btcrelay: {
    packageId: string;
    upgradeCapId: string;
    adminId: string;
    relayId: string;
  };
  mockTokens: {
    btc: {
      packageId: string;
      treasuryCapId: string;
      metadataId: string;
    };
    usdt: {
      packageId: string;
      treasuryCapId: string;
      metadataId: string;
    };
    usdc: {
      packageId: string;
      treasuryCapId: string;
      metadataId: string;
    };
  };
  mainPackage: {
    testnet: {
      packageId: string;
    };
    mainnet: {
      packageId: string;
    };
  };
  adminCaps: {
    burnRouterAdminId: string;
    exchangeAdminId: string;
    ccTransferAdminId: string;
    lockerAdminCapId: string;
  };
  telebtc: {
    adminId: string;
    capId: string;
    treasuryCapId: string;
    metadataId: string;
  };
  initializedObjects: {
    ccTransferRouterId: string;
    burnRouterId: string;
    lockerCapId: string;
    exchangeCapId: string;
  };
  cetusPools?: Record<string, string>;
}

export class PackageManager {
  private filePath: string;
  private data: PackageIdStructure;

  constructor(filePath?: string) {
    this.filePath = filePath || path.join(__dirname, '../../package_id.json');
    this.data = this.loadData();
  }

  private loadData(): PackageIdStructure {
    if (fs.existsSync(this.filePath)) {
      try {
        const content = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(content);
        return parsed as PackageIdStructure;
        
        
      } catch (error) {
        console.warn('Failed to parse package_id.json, using default structure');
      }
    }
    
    return this.getDefaultStructure();
  }


  private getDefaultStructure(): PackageIdStructure {
    return {
      btcrelay: {
        packageId: '',
        upgradeCapId: '',
        adminId: '',
        relayId: ''
      },
      mockTokens: {
        btc: {
          packageId: '',
          treasuryCapId: '',
          metadataId: ''
        },
        usdt: {
          packageId: '',
          treasuryCapId: '',
          metadataId: ''
        },
        usdc: {
          packageId: '',
          treasuryCapId: '',
          metadataId: ''
        }
      },
      mainPackage: {
        testnet: {
          packageId: ''
        },
        mainnet: {
          packageId: ''
        }
      },
      adminCaps: {
        burnRouterAdminId: '',
        exchangeAdminId: '',
        ccTransferAdminId: '',
        lockerAdminCapId: ''
      },
      telebtc: {
        adminId: '',
        capId: '',
        treasuryCapId: '',
        metadataId: ''
      },
      initializedObjects: {
        ccTransferRouterId: '',
        burnRouterId: '',
        lockerCapId: '',
        exchangeCapId: ''
      },
      cetusPools: {}
    };
  }

  public save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  // Getters
  public getBtcrelay() { return this.data.btcrelay; }
  public getMockTokens() { return this.data.mockTokens; }
  public getMainPackage(network: 'testnet' | 'mainnet') { return this.data.mainPackage[network]; }
  public getAdminCaps() { return this.data.adminCaps; }
  public getTelebtc() { return this.data.telebtc; }
  public getInitializedObjects() { return this.data.initializedObjects; }
  public getCetusPools() {
    if (!this.data.cetusPools) this.data.cetusPools = {};
    return this.data.cetusPools as Record<string, string>;
  }
  public getCetusPool(name: string) {
    const pools = this.getCetusPools();
    return pools[name];
  }

  // Setters
  public setBtcrelay(btcrelay: Partial<PackageIdStructure['btcrelay']>) {
    this.data.btcrelay = { ...this.data.btcrelay, ...btcrelay };
  }

  public setMockToken(token: 'btc' | 'usdt' | 'usdc', data: Partial<PackageIdStructure['mockTokens'][typeof token]>) {
    this.data.mockTokens[token] = { ...this.data.mockTokens[token], ...data };
  }

  public setMainPackage(network: 'testnet' | 'mainnet', packageId: string) {
    this.data.mainPackage[network].packageId = packageId;
  }

  public setAdminCaps(adminCaps: Partial<PackageIdStructure['adminCaps']>) {
    this.data.adminCaps = { ...this.data.adminCaps, ...adminCaps };
  }

  public setTelebtc(telebtc: Partial<PackageIdStructure['telebtc']>) {
    this.data.telebtc = { ...this.data.telebtc, ...telebtc };
  }

  public setInitializedObjects(initializedObjects: Partial<PackageIdStructure['initializedObjects']>) {
    this.data.initializedObjects = { ...this.data.initializedObjects, ...initializedObjects };
  }

  public setCetusPool(name: string, poolId: string) {
    if (!this.data.cetusPools) this.data.cetusPools = {};
    this.data.cetusPools![name] = poolId;
  }

  // Legacy compatibility methods
  public getLegacyFormat() {
    return {
      btcrelayPackageId: this.data.btcrelay.packageId,
      btcrelayUpgradeCapId: this.data.btcrelay.upgradeCapId,
      btcrelayAdminId: this.data.btcrelay.adminId,
      btcRelayId: this.data.btcrelay.relayId,
      mockBtcPackageId: this.data.mockTokens.btc.packageId,
      mockUsdtPackageId: this.data.mockTokens.usdt.packageId,
      mockUsdcPackageId: this.data.mockTokens.usdc.packageId,
      mainTestnetPackageId: this.data.mainPackage.testnet.packageId,
      mainMainnetPackageId: this.data.mainPackage.mainnet.packageId,
      burnRouterAdminId: this.data.adminCaps.burnRouterAdminId,
      exchangeAdminId: this.data.adminCaps.exchangeAdminId,
      ccTransferAdminId: this.data.adminCaps.ccTransferAdminId,
      lockerAdminCapId: this.data.adminCaps.lockerAdminCapId,
      telebtcAdminId: this.data.telebtc.adminId,
      telebtcCapId: this.data.telebtc.capId,
      telebtcTreasuryCapId: this.data.telebtc.treasuryCapId,
      mockBtcTreasuryCapId: this.data.mockTokens.btc.treasuryCapId,
      mockUsdtTreasuryCapId: this.data.mockTokens.usdt.treasuryCapId,
      mockUsdcTreasuryCapId: this.data.mockTokens.usdc.treasuryCapId,
      mockBtcMetadataId: this.data.mockTokens.btc.metadataId,
      mockUsdtMetadataId: this.data.mockTokens.usdt.metadataId,
      mockUsdcMetadataId: this.data.mockTokens.usdc.metadataId,
      ccTransferRouterId: this.data.initializedObjects.ccTransferRouterId,
      burnRouterId: this.data.initializedObjects.burnRouterId,
      lockerCapId: this.data.initializedObjects.lockerCapId,
      exchangeCapId: this.data.initializedObjects.exchangeCapId
    };
  }
}
