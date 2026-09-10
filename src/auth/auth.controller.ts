import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  async signup(@Body() body: SignupDto) {
    await this.auth.signup(body.fullName, body.email, body.password);
    return { message: 'Verification code sent to your email' };
  }

  @Post('verify-otp')
  async verifyOtp(
    @Body() body: VerifyOtpDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.verifyOtp(body.email, body.otp);
    response.cookie(
      this.auth.getCookieName(),
      result.token,
      this.auth.getCookieOptions(),
    );
    return { user: result.user };
  }

  @Post('login')
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(body.email, body.password);
    response.cookie(
      this.auth.getCookieName(),
      result.token,
      this.auth.getCookieOptions(),
    );
    return { user: result.user };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(
      this.auth.getCookieName(),
      this.auth.getCookieOptions(),
    );
    return { message: 'Logged out' };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() request: Request & { user: unknown }) {
    return { user: request.user };
  }
}
