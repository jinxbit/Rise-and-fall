import { Analytics } from '@vercel/analytics/react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AdminMapsPage } from './pages/AdminMapsPage'
import { AdminRoomsPage } from './pages/AdminRoomsPage'
import { CreateGamePage } from './pages/CreateGamePage'
import { GamePage } from './pages/GamePage'
import { HomePage } from './pages/HomePage'
import { LobbyPage } from './pages/LobbyPage'
import { MapBuilderPage } from './pages/MapBuilderPage'
import { MyGamesPage } from './pages/MyGamesPage'
import { ProfilePage } from './pages/ProfilePage'
import { PublicRoomsPage } from './pages/PublicRoomsPage'
import { ResetPasswordPage } from './pages/ResetPasswordPage'
import { EnvironmentBadge } from './components/EnvironmentBadge'
import { resolveEnvironmentBadge } from './components/environmentBadge'
import { UpdateBanner } from './components/UpdateBanner'
import { useAppUpdateAvailable } from './hooks/useAppUpdateAvailable'

function App() {
  const updateAvailable = useAppUpdateAvailable()
  // Non-production builds say so on screen — see ./components/environmentBadge.ts
  // for why, and why production is the case that needs no configuration.
  const environmentBadge = resolveEnvironmentBadge(import.meta.env.VITE_ENVIRONMENT, import.meta.env.VITE_SUPABASE_URL)

  return (
    <BrowserRouter>
      <div className="min-h-screen bg-neutral-950 text-neutral-100">
        {updateAvailable && <UpdateBanner onReload={() => window.location.reload()} />}
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/create" element={<CreateGamePage />} />
          <Route path="/map-builder" element={<MapBuilderPage />} />
          <Route path="/admin/maps" element={<AdminMapsPage />} />
          <Route path="/admin/rooms" element={<AdminRoomsPage />} />
          <Route path="/games" element={<MyGamesPage />} />
          <Route path="/public" element={<PublicRoomsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/lobby/:roomCode" element={<LobbyPage />} />
          <Route path="/game/:roomCode" element={<GamePage />} />
        </Routes>
        {environmentBadge && <EnvironmentBadge {...environmentBadge} />}
      </div>
      <Analytics />
    </BrowserRouter>
  )
}

export default App
