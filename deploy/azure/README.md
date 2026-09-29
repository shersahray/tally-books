# Putting Tally Books online with Azure

This puts Tally Books on a small server in Microsoft's Toronto data centre (Canada Central). You and your clients sign in from any browser at an address like `https://yourname-books.canadacentral.cloudapp.azure.com`.

Everything is done in the [Azure portal](https://portal.azure.com). You never need to type commands on the server: when a step says "Run command", use the portal's **Run command** page (step 6).

Expect about 45 minutes, most of it waiting.

**What it costs:** roughly US$23 a month for the server, disk and address, plus a few cents for backup storage. Set a budget alert (step 1) so there are no surprises.

---

## 1. Budget alert (2 minutes)

1. Search the portal for **Cost Management**, then open **Budgets** and choose **+ Add**.
2. Set the amount to **50** per month and add an alert at **80%** to your email.

## 2. Resource group

A resource group is a folder that holds everything for Tally Books.

1. Search for **Resource groups**, then choose **+ Create**.
2. Name: `tally-books`. Region: **Canada Central**.
3. Choose **Review + create**, then **Create**.

## 3. The server

Search for **Virtual machines** and choose **+ Create → Azure virtual machine**.

**Basics tab**
- **Resource group:** `tally-books`
- **Virtual machine name:** `tally-books`
- **Region:** (Canada) Canada Central
- **Availability options:** No infrastructure redundancy required
- **Security type:** Trusted launch
- **Image:** Ubuntu Server 24.04 LTS – x64 Gen2
- **Size:** **Standard_B1ms** (1 vCPU, 2 GiB). Choose *See all sizes* if it isn't listed.
- **Authentication type:** SSH public key. Let Azure generate a new key pair, and keep the `.pem` file it downloads somewhere safe. You won't need it day to day.
- **Public inbound ports:** Allow selected ports. Tick **HTTP (80)** and **HTTPS (443)**. **Don't** tick SSH (22).

**Disks tab**
- **OS disk type:** Standard SSD.

**Networking tab**
- Leave the defaults (a new virtual network and a new public IP address).

**Advanced tab**
1. Open [`setup.sh`](setup.sh), copy the whole file, and paste it into **Custom data**.
2. Before moving on, edit the three lines near the top, in the Custom data box:
   - **`DOMAIN`**: pick a short name for your address, such as `sher-books`. Your address becomes `sher-books.canadacentral.cloudapp.azure.com`. You'll enter the same name in step 4.
   - **`EMAIL`**: your email address, for notices about the HTTPS certificate.
   - **`SETUP_CODE`**: a phrase only you know, at least 10 characters, such as `purple canoe 1987`. You'll type it once, when you create your owner account.

   If you forget to change the setup code, the server makes a random one. You can see it by running this in **Run command** (step 6):

   ```
   grep SETUP_CODE /var/log/tally-setup.log
   ```

Choose **Review + create**, then **Create**. Download the key when asked, then wait for "Your deployment is complete".

## 4. The web address

1. Open the new virtual machine. Next to **Public IP address**, click the address.
2. Open **Settings → Configuration**.
3. **Assignment:** Static (so the address never changes).
4. **DNS name label:** the same name you used in `DOMAIN`, for example `sher-books`.
5. Choose **Save**.

## 5. First sign-in

Wait about 10 minutes after creating the server: it installs everything and gets its HTTPS certificate. Then open `https://<your address>`.

1. You'll see **Welcome to Tally Books**. Enter your **setup code**, your name, your email and a password.
2. Set up **two-step sign-in**: scan the QR code with Microsoft Authenticator or Google Authenticator on your phone, and enter the code it shows. Every account on the online server needs this.
3. **Save your recovery codes.** If you lose your phone, they're the only way back in without another owner.

If the page doesn't load after 20 minutes, see [Checking on the server](#6-checking-on-the-server).

## 6. Checking on the server

Open the virtual machine, then **Operations → Run command → RunShellScript**. Type:

```
tally-status
```

Choose **Run**. After about 30 seconds you'll see:
- whether the app and HTTPS are running;
- which version is installed;
- when the next update happens;
- how much disk space is free;
- the latest messages from the app.

If setup is still going, you can follow its progress with:

```
tail -n 30 /var/log/tally-setup.log
```

## 7. Off-site backups (Azure Storage)

The server keeps a backup of every company each day on its own disk. This step adds a second copy in Azure Storage, so the books survive even if the server is deleted.

The server gets **write-only** access to that storage. Even if someone broke into the server, they couldn't read or delete the off-site copies. Old copies are kept as earlier versions, and Azure itself removes backups after 30 days.

1. Search for **Storage accounts**, then choose **+ Create**.
   - **Resource group:** `tally-books`
   - **Storage account name:** something like `sherbooksbackups`. Use lowercase letters and numbers only.
   - **Region:** Canada Central
   - **Performance:** Standard
   - **Redundancy:** **Geo-redundant storage (GRS)**. This keeps a second copy in Canada East (Quebec City), so the data stays in Canada.
   - On the **Data protection** tab, turn on:
     - **soft delete for blobs:** 30 days;
     - **soft delete for containers:** 30 days;
     - **versioning for blobs**.
   - Choose **Review + create**, then **Create**.
2. Open the storage account, then **Data storage → Containers → + Container**. Name: `tally-backups`. Access level: **Private**.
3. Open **Data management → Lifecycle management → Add a rule**.
   - **Rule name:** `delete-old-backups`
   - **Rule scope:** apply to all blobs.
   - **Base blobs:** if last modified more than **30** days ago, then **Delete the blob**.
   - **Previous versions:** if older than **30** days, then **Delete**.
4. Open the container, then **Settings → Shared access tokens**:
   - **Permissions:** **Create** and **Write** only.
   - **Expiry:** two years from today. Put a reminder in your calendar to renew it.
   - Choose **Generate SAS token and URL**, then copy the **Blob SAS URL**.

   Treat this URL like a password. Don't email it, and don't paste it anywhere except the next step.
5. On the virtual machine, open **Run command → RunShellScript** and run the line below, with your URL between the quotes:

   ```
   tally-set-backup 'PASTE-THE-BLOB-SAS-URL-HERE'
   ```

6. In Tally Books, go to **Settings → Automatic backups** and click **Back up now**. The status line should mention the off-site copy.

**To restore from an off-site copy:** open the storage account in the portal, go to the container and the day's folder, and download the company's `.json` file. Then use **Settings → Restore from backup** in Tally Books.

## 8. Invite clients

Open **Users & security → + Add user**.
- **Client:** sees only their own company. Tick **View only** if they should look but not change anything.
- **Staff:** works in the companies you pick.

You get an **invitation link** to send them yourself. It works once, for 7 days. They choose their own password and set up two-step sign-in.

- **Forgotten password:** open the user and choose **Password reset link**.
- **Lost phone:** choose **Reset two-step sign-in**. Only do this when you're sure it's really them asking.

## Updates

Every night at 3:15 a.m. (Toronto time), the server checks GitHub for a new version. It runs all the tests on the new version before switching to it. If the new version doesn't start, the server goes back to the previous one on its own.

Updates run under a separate account that can't see the books or the settings file.

**The server trusts whatever is on GitHub's `main` branch**, so protect that GitHub account:
- turn on two-factor authentication under GitHub **Settings → Password and authentication**;
- don't give anyone else write access to the repository.

Ubuntu security updates install automatically too. If one needs a restart, it happens at 4 a.m.

To update right away, use **Run command**:

```
tally-update
```

## Good to know

- **Where the books are:** `/var/lib/tally-books/data`, readable only by the Tally Books service. Nothing about your clients goes to GitHub.
- **Restoring over a company:** only owners can do this. Tally Books first saves a copy of what it's replacing in `/var/lib/tally-books/data/before-restore`.
- **Sign-in activity:** under **Users & security → Sign-in activity** you can see every sign-in, failed attempt and account change. The **Activity log** under Settings shows every change to a company's books.
- **Two-step sign-in is required for everyone** on the online server. This is set in `/etc/tally-books.env` (`REQUIRE_2FA=everyone`).
- **A bigger server:** if the app ever feels slow with many clients, stop the virtual machine, choose **Size → Standard_B2s**, and start it again.
- **Your own domain:** to use an address like `books.yourfirm.ca`, add a DNS **A record** pointing to the server's IP address. Then change the address in `/etc/caddy/Caddyfile` and run `systemctl reload caddy`.
