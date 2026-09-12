import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { Model } from 'mongoose';
import { User, UserDocument } from '../users/schemas/user.schema';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
}

@Injectable()
export class AuthService {
  private readonly ses: SESv2Client;

  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.ses = new SESv2Client({
      region: this.config.get<string>('AWS_REGION') ?? 'us-east-1',
    });
  }

  async signup(
    fullName: string,
    email: string,
    password: string,
  ): Promise<void> {
    this.validateCredentials(fullName, email, password);
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await this.users
      .findOne({ email: normalizedEmail })
      .select('+passwordHash +otpHash +otpExpiresAt');

    if (existing?.emailVerified) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const otp = randomInt(100000, 1000000).toString();
    const update = {
      fullName: fullName.trim(),
      email: normalizedEmail,
      passwordHash,
      emailVerified: false,
      otpHash: await bcrypt.hash(otp, 10),
      otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    };

    await this.users.findOneAndUpdate(
      { email: normalizedEmail },
      { $set: update, $setOnInsert: { role: 'buyer', isActive: true } },
      { upsert: true, new: true },
    );
    await this.sendOtp(normalizedEmail, otp);
  }

  async verifyOtp(
    email: string,
    otp: string,
  ): Promise<{ user: AuthUser; token: string }> {
    const user = await this.users
      .findOne({ email: email.trim().toLowerCase() })
      .select('+otpHash +otpExpiresAt');
    if (
      !user?.otpHash ||
      !user.otpExpiresAt ||
      user.otpExpiresAt < new Date()
    ) {
      throw new BadRequestException('The OTP is invalid or expired');
    }
    if (!(await bcrypt.compare(otp, user.otpHash))) {
      throw new BadRequestException('The OTP is invalid or expired');
    }

    user.emailVerified = true;
    user.otpHash = undefined;
    user.otpExpiresAt = undefined;
    await user.save();
    return this.issueToken(user);
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ user: AuthUser; token: string }> {
    const user = await this.users
      .findOne({ email: email.trim().toLowerCase() })
      .select('+passwordHash');
    if (
      !user?.passwordHash ||
      !(await bcrypt.compare(password, user.passwordHash))
    ) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!user.emailVerified) {
      throw new UnauthorizedException('Verify your email before logging in');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('This account is inactive');
    }
    return this.issueToken(user);
  }

  getCookieOptions() {
    const isProduction = this.config.get<string>('NODE_ENV') === 'production';

    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? ('none' as const) : ('lax' as const),
      maxAge: Number(
        this.config.get<string>('AUTH_COOKIE_MAX_AGE_MS') ?? 604800000,
      ),
    };
  }

  getCookieName(): string {
    return this.config.get<string>('AUTH_COOKIE_NAME') ?? 'access_token';
  }

  private issueToken(user: UserDocument): { user: AuthUser; token: string } {
    const authUser: AuthUser = {
      id: user._id.toString(),
      email: user.email!,
      fullName: user.fullName,
      role: user.role,
    };
    return { user: authUser, token: this.jwt.sign(authUser) };
  }

  private async sendOtp(email: string, otp: string): Promise<void> {
    const from = this.config.get<string>('SES_FROM_EMAIL');
    if (!from) {
      throw new BadRequestException('SES_FROM_EMAIL is not configured');
    }
    await this.ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [email] },
        Content: {
          Simple: {
            Subject: { Data: 'Your verification code' },
            Body: {
              Text: {
                Data: `Your verification code is ${otp}. It expires in 10 minutes.`,
              },
            },
          },
        },
      }),
    );
  }

  private validateCredentials(
    fullName: string,
    email: string,
    password: string,
  ): void {
    if (!fullName?.trim() || !email?.trim() || !password) {
      throw new BadRequestException(
        'fullName, email, and password are required',
      );
    }
    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }
  }
}
