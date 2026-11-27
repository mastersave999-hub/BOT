import { clerkMiddleware } from '@clerk/nextjs/server'

// Clerk is optional: without keys the middleware passes requests through so the
// app runs in guest mode instead of throwing on every route.
const clerkEnabled =
  !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && !!process.env.CLERK_SECRET_KEY;

export default clerkEnabled
  ? clerkMiddleware()
  : function clerkOptionalPassthrough() {};

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/(.*)',
  ],
}
