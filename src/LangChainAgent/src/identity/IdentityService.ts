import * as fs from "fs";
import * as path from "path";

const IDENTITY_FILE = path.join(__dirname, "../../identity.json");

export interface IdentityData {
  system_identity: {
    name: string;
    version: string;
    tagline: string;
    branding: {
      owner: string;
      organization: string;
      address: string;
      location: string;
    };
    contact: {
      phone: string;
      email: string;
      website: string;
    };
    license: string;
    system_prompt?: string;
  };
}

export class IdentityService {
  private static instance: IdentityService;
  private identity: IdentityData | null = null;

  private constructor() {}

  public static getInstance(): IdentityService {
    if (!IdentityService.instance) {
      IdentityService.instance = new IdentityService();
    }
    return IdentityService.instance;
  }

  public loadIdentity(): IdentityData {
    if (this.identity) {
      return this.identity;
    }

    try {
      const rawData = fs.readFileSync(IDENTITY_FILE, "utf-8");
      this.identity = JSON.parse(rawData);
      return this.identity!;
    } catch (error) {
      throw new Error(
        `Failed to load identity.json: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  public getIdentityString(): string {
    const identity = this.loadIdentity();
    return `আমি ${identity.system_identity.name}, ${identity.system_identity.tagline}। আমার নির্মাতা ও মালিক ${identity.system_identity.branding.owner}, ${identity.system_identity.branding.organization}।`;
  }

  public getOwnerInfo(): string {
    const identity = this.loadIdentity();
    return `${identity.system_identity.branding.owner} (${identity.system_identity.branding.organization}) - ${identity.system_identity.branding.location}`;
  }

  public getResponseHeaders(): Record<string, string> {
    const identity = this.loadIdentity();
    return {
      "X-Powered-By": `ZombieCoder-by-${identity.system_identity.branding.owner.replace(/\s+/g, "")}`,
      "X-System-Name": identity.system_identity.name,
      "X-System-Version": identity.system_identity.version,
    };
  }

  public validateIdentity(): boolean {
    try {
      const identity = this.loadIdentity();
      return !!(
        identity.system_identity.name &&
        identity.system_identity.branding.owner &&
        identity.system_identity.contact.email
      );
    } catch {
      return false;
    }
  }
}
