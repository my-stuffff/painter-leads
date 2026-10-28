import { lazy } from 'react';
import { createBrowserRouter } from 'react-router';
import { RequireAuth } from './auth';
import { HomePage } from './pages/Home';
import { JobPage } from './pages/Job';
import { NotFoundPage } from './pages/NotFound';
import { SearchesPage } from './pages/Searches';
import { SignInPage } from './pages/SignIn';

// The map data (us-atlas) and the users screen load only when opened.
const NewSearchPage = lazy(() => import('./pages/NewSearch'));
const UsersPage = lazy(() => import('./pages/Users'));

export const router = createBrowserRouter([
  { path: '/sign-in', element: <SignInPage /> },
  {
    path: '/',
    element: <RequireAuth />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'searches', element: <SearchesPage /> },
      { path: 'searches/new', element: <NewSearchPage /> },
      { path: 'searches/:id', element: <JobPage /> },
      { path: 'users', element: <UsersPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
